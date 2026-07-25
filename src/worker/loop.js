'use strict';

/**
 * Worker loop — runs as a forked child process.
 *
 * This is the core of the job queue. Each iteration:
 * 1. Runs the reaper sweep (reclaim stuck jobs from dead workers)
 * 2. Tries to atomically claim one pending job
 * 3. If claimed, executes it with heartbeat updates
 * 4. Handles success (→ completed) or failure (→ retry or DLQ)
 *
 * Shutdown: the supervisor sends an IPC message { type: 'shutdown' },
 * or a SIGTERM/SIGINT is received. Either sets shuttingDown = true.
 * The loop finishes the current job (if any) before exiting —
 * no new claims once the flag is set.
 */

const { exec } = require('child_process');
const { getDb } = require('../db');

// --- Tuning constants ---
// These three values determine worst-case crash recovery time.
// See DECISIONS.md for the math: 5s + 20s + 5s = 30s < 60s.
const POLL_INTERVAL_MS = 5000;   // How often the loop checks for new jobs (5s)
const HEARTBEAT_INTERVAL_MS = 5000; // How often we update heartbeat_at during execution (5s)
const LEASE_TIMEOUT_S = 20;      // Seconds before a stale job is reclaimed by the reaper (20s)

let shuttingDown = false;

// Register signal handlers ONCE at startup, not per-job.
// Adding handlers inside the loop would stack duplicate listeners.
process.on('SIGTERM', () => {
  shuttingDown = true;
  // Don't call process.exit() — let the loop finish the current job.
});
process.on('SIGINT', () => {
  shuttingDown = true;
});

// IPC message from the supervisor process.
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') {
    shuttingDown = true;
  }
});

// --- Worker ID ---
// Each worker gets a unique ID based on its PID.
// This is stored on claimed jobs so we can trace which worker ran what.
const workerId = `worker-${process.pid}`;

// --- Main loop ---
const db = getDb();

// Prepared statements — created once, reused every iteration.
// better-sqlite3 prepared statements are safe to reuse.
const reaperStmt = db.prepare(`
  UPDATE jobs
  SET state = 'pending', worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
      next_retry_at = ?
  WHERE state = 'processing' AND heartbeat_at < ?
`);

// The atomic claim query. This is the single most important line in the project.
// It atomically finds the oldest claimable job whose retry delay has elapsed,
// and updates it to 'processing' in one statement. SQLite serializes all
// writers at the database-file level (even across separate OS processes),
// so two workers racing on the same row will result in exactly one getting
// changes=1 and the other getting changes=0. No application-level lock needed.
//
// We check for both 'pending' (new jobs) and 'failed' (retryable jobs whose
// backoff has elapsed). This makes the 'failed' state visible in status/list
// while a job is waiting for its retry delay.
const claimStmt = db.prepare(`
  UPDATE jobs
  SET state = 'processing', worker_id = ?, claimed_at = ?, heartbeat_at = ?
  WHERE id = (
    SELECT id FROM jobs
    WHERE state IN ('pending', 'failed') AND next_retry_at <= ?
    ORDER BY created_at
    LIMIT 1
  )
  AND state IN ('pending', 'failed')
`);

const fetchClaimedStmt = db.prepare(`
  SELECT * FROM jobs WHERE worker_id = ? AND state = 'processing'
  ORDER BY claimed_at DESC LIMIT 1
`);

const heartbeatStmt = db.prepare(`
  UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND state = 'processing'
`);

const completeStmt = db.prepare(`
  UPDATE jobs
  SET state = 'completed', updated_at = ?, worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
  WHERE id = ?
`);

// Retry: increment attempts, decide between 'failed' (retry) or 'dead' (DLQ).
// This is split into two statements because the branching logic (retry vs dead)
// depends on comparing attempts to max_retries, which is cleaner in JS than SQL.
// Note: state='failed' (not 'pending') so the job is visible via `list --state failed`
// while waiting for its backoff delay. The claim query picks up 'failed' jobs
// once next_retry_at has elapsed.
const retryStmt = db.prepare(`
  UPDATE jobs
  SET state = 'failed', attempts = ?, updated_at = ?, last_error = ?,
      worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL,
      next_retry_at = ?
  WHERE id = ?
`);

const deadStmt = db.prepare(`
  UPDATE jobs
  SET state = 'dead', attempts = ?, updated_at = ?, last_error = ?,
      worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
  WHERE id = ?
`);

/**
 * Execute a single job's command in a child shell.
 * Returns a promise that resolves with { code, stdout, stderr }.
 * The heartbeat interval runs while the command is executing,
 * updating heartbeat_at so the reaper knows this job is alive.
 */
function executeJob(job) {
  return new Promise((resolve) => {
    const now = () => new Date().toISOString();

    // Start the heartbeat interval. This runs every 5s while the job
    // is executing, updating heartbeat_at. If this worker dies (SIGKILL),
    // the heartbeat stops, and the reaper will notice after LEASE_TIMEOUT_S.
    const heartbeatTimer = setInterval(() => {
      try {
        heartbeatStmt.run(now(), job.id);
      } catch (err) {
        // DB might be locked momentarily — not fatal, next heartbeat will succeed.
        console.error(`[${workerId}] Heartbeat failed for job ${job.id}: ${err.message}`);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const child = exec(job.command, { timeout: 0 }, (error, stdout, stderr) => {
      // Always clear the heartbeat timer, whether the job succeeded or failed.
      clearInterval(heartbeatTimer);

      if (error) {
        resolve({ code: error.code || 1, stdout, stderr, error: error.message });
      } else {
        resolve({ code: 0, stdout, stderr, error: null });
      }
    });
  });
}

/**
 * Run one iteration of the claim-execute loop.
 * Returns true if a job was claimed and processed, false if idle.
 */
async function runOnce() {
  const now = new Date().toISOString();

  // --- Step 1: Reaper sweep ---
  // Reclaim jobs stuck in 'processing' past the lease timeout.
  // This handles the case where a worker was SIGKILLed mid-job and couldn't
  // clean up. Any live worker running this loop will eventually sweep these.
  const cutoff = new Date(Date.now() - LEASE_TIMEOUT_S * 1000).toISOString();
  const reaped = reaperStmt.run(now, cutoff);
  if (reaped.changes > 0) {
    console.error(`[${workerId}] Reaped ${reaped.changes} stale job(s)`);
  }

  // --- Step 2: Atomic claim ---
  const result = claimStmt.run(workerId, now, now, now);

  if (result.changes === 0) {
    // No pending jobs available right now. Return false to trigger a sleep.
    return false;
  }

  // --- Step 3: Fetch the job we just claimed ---
  const job = fetchClaimedStmt.get(workerId);
  if (!job) {
    // Shouldn't happen — we just claimed it. But defensive coding.
    console.error(`[${workerId}] Claimed a job but couldn't fetch it. Skipping.`);
    return false;
  }

  console.error(`[${workerId}] Executing job ${job.id}: ${job.command}`);

  // --- Step 4: Execute ---
  const result2 = await executeJob(job);
  const finishedAt = new Date().toISOString();

  if (result2.code === 0) {
    // --- Success ---
    completeStmt.run(finishedAt, job.id);
    console.error(`[${workerId}] Job ${job.id} completed successfully`);
  } else {
    // --- Failure ---
    const newAttempts = job.attempts + 1;
    const errorMsg = result2.error || result2.stderr || `Exit code ${result2.code}`;

    if (newAttempts >= job.max_retries) {
      // Max retries exhausted → move to dead letter queue.
      deadStmt.run(newAttempts, finishedAt, errorMsg, job.id);
      console.error(`[${workerId}] Job ${job.id} moved to DLQ after ${newAttempts} attempt(s)`);
    } else {
      // Schedule retry with exponential backoff: delay = base^attempts seconds.
      const delaySec = Math.pow(job.backoff_base, newAttempts);
      const nextRetry = new Date(Date.now() + delaySec * 1000).toISOString();
      retryStmt.run(newAttempts, finishedAt, errorMsg, nextRetry, job.id);
      console.error(`[${workerId}] Job ${job.id} failed (attempt ${newAttempts}/${job.max_retries}), retry in ${delaySec}s`);
    }
  }

  return true;
}

/**
 * Main loop: claim and execute jobs until shutdown is requested.
 */
async function mainLoop() {
  console.error(`[${workerId}] Worker started (PID: ${process.pid})`);

  while (!shuttingDown) {
    try {
      const didWork = await runOnce();

      // If we didn't claim any job, sleep before polling again.
      // If we did work, immediately try to claim the next job (no sleep).
      if (!didWork && !shuttingDown) {
        await sleep(POLL_INTERVAL_MS);
      }
    } catch (err) {
      // Don't let a single iteration crash the entire worker.
      // Log the error and keep going — the next iteration may succeed.
      console.error(`[${workerId}] Loop error: ${err.message}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  console.error(`[${workerId}] Shutting down gracefully`);
  db.close();
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Start the loop when this file is run as a forked child process.
mainLoop();
