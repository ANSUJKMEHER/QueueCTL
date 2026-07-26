#!/usr/bin/env node
'use strict';

/**
 * verify.js — Self-test script that exercises the 5 required scenarios.
 *
 * Runs each scenario in sequence, printing PASS/FAIL for each.
 * Uses a fresh database for each test (deletes and recreates data/).
 *
 * Usage: node scripts/verify.js
 *
 * Prerequisites: npm install must have been run (better-sqlite3 + commander).
 */

const { execSync, spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = path.join(__dirname, '..');
const BIN = path.join(PROJECT_ROOT, 'bin', 'queuectl.js');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const WORKERS_DIR = path.join(PROJECT_ROOT, 'workers');

let passed = 0;
let failed = 0;

// --- Helpers ---

function run(args, opts = {}) {
  const cmd = `node ${BIN} ${args}`;
  try {
    return execSync(cmd, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      ...opts,
    });
  } catch (err) {
    if (opts.expectFail) return err.stdout || '';
    throw err;
  }
}

function listJson(state) {
  const stdout = run(`list --state ${state} --json`);
  return JSON.parse(stdout.trim());
}

function cleanDb() {
  // Remove DB and PID files between tests for isolation.
  if (fs.existsSync(DATA_DIR)) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  if (fs.existsSync(WORKERS_DIR)) {
    fs.rmSync(WORKERS_DIR, { recursive: true, force: true });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Spawn a worker in the background. Returns { proc, kill() }.
 * The worker runs in the foreground of a child process, not our main process.
 */
function spawnWorker(count = 1) {
  const proc = spawn('node', [BIN, 'worker', 'start', '--count', String(count)], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Collect stderr for debugging.
  let stderr = '';
  proc.stderr.on('data', (data) => { stderr += data.toString(); });

  return {
    proc,
    getStderr: () => stderr,
    kill: (signal = 'SIGTERM') => {
      try { process.kill(proc.pid, signal); } catch (e) { /* already dead */ }
    },
  };
}

function report(name, pass, detail) {
  if (pass) {
    console.log(`  ✅ PASS: ${name}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${name} — ${detail}`);
    failed++;
  }
}

// --- Scenarios ---

async function scenario1_BasicCompletion() {
  console.log('\n--- Scenario 1: Basic job completes ---');
  cleanDb();

  // Enqueue a simple echo job.
  run('enqueue \'{"id":"s1-job","command":"echo hello"}\'');

  // Start a worker, wait for it to process, then stop.
  const worker = spawnWorker(1);
  await sleep(8000); // Wait for claim loop to pick up and execute the job.

  worker.kill();
  await sleep(2000); // Let worker exit.

  const completed = listJson('completed');
  report('Job completed', completed.length === 1 && completed[0].id === 's1-job',
    `Expected 1 completed job, got ${completed.length}`);
}

async function scenario2_RetryAndDLQ() {
  console.log('\n--- Scenario 2: Failing job retries → DLQ ---');
  cleanDb();

  // Enqueue a job that always fails, with max_retries=2 and backoff_base=1 (1s delay).
  // This means: attempt 1 fails → retry after 1^1=1s → attempt 2 fails → DLQ.
  run('enqueue \'{"id":"s2-fail","command":"exit 1","max_retries":2,"backoff_base":1}\'');

  const worker = spawnWorker(1);
  // 2 attempts with 1s backoff + poll intervals ≈ needs ~20s to complete all retries.
  await sleep(25000);

  worker.kill();
  await sleep(2000);

  const dead = listJson('dead');
  report('Job in DLQ after retries', dead.length === 1 && dead[0].id === 's2-fail',
    `Expected 1 dead job, got ${dead.length}`);
  report('Attempts match max_retries', dead.length > 0 && dead[0].attempts === 2,
    `Expected 2 attempts, got ${dead.length > 0 ? dead[0].attempts : 'N/A'}`);
}

async function scenario3_ConcurrencyExactlyOnce() {
  console.log('\n--- Scenario 3: Multiple workers, each job runs exactly once ---');
  cleanDb();

  // Enqueue 10 jobs.
  for (let i = 0; i < 10; i++) {
    run(`enqueue '{"id":"s3-job-${i}","command":"echo job${i}"}'`);
  }

  // Start 3 workers.
  const worker = spawnWorker(3);
  await sleep(20000); // Wait for all jobs to be claimed and executed.

  worker.kill();
  await sleep(2000);

  const completed = listJson('completed');
  report('All 10 jobs completed', completed.length === 10,
    `Expected 10 completed, got ${completed.length}`);

  // Check no duplicates (each job ID should appear exactly once).
  const ids = completed.map(j => j.id);
  const unique = new Set(ids);
  report('No duplicate executions', unique.size === ids.length,
    `Expected ${ids.length} unique IDs, got ${unique.size}`);
}

async function scenario4_SigkillRecovery() {
  console.log('\n--- Scenario 4: SIGKILL recovery ---');
  cleanDb();

  // Enqueue a job that takes a while (sleep 15).
  run('enqueue \'{"id":"s4-job","command":"sleep 15"}\'');

  // Start a worker.
  const worker = spawnWorker(1);
  await sleep(5000); // Wait for the job to be claimed and start executing.

  // Verify the job is processing.
  let processing = listJson('processing');
  report('Job is processing', processing.length === 1,
    `Expected 1 processing job, got ${processing.length}`);

  // SIGKILL the worker (untrappable — simulates a crash).
  worker.kill('SIGKILL');
  await sleep(2000);

  // The job should still be in 'processing' (no one cleaned it up yet).
  processing = listJson('processing');
  report('Job still processing after SIGKILL', processing.length === 1,
    `Expected 1 processing job, got ${processing.length}`);

  // Start a new worker — its reaper sweep should reclaim the stuck job.
  // With LEASE_TIMEOUT=20s and heartbeat stopping at SIGKILL time,
  // the reaper should pick it up on the first or second sweep.
  const worker2 = spawnWorker(1);
  await sleep(60000); // Wait for reaper (≤30s) + job execution (sleep 15) with extra safety margin.

  worker2.kill();
  await sleep(2000);

  // The job should now be completed (the second worker re-ran it).
  const completed = listJson('completed');
  report('Job recovered and completed', completed.length === 1,
    `Expected 1 completed job, got ${completed.length}`);

  // Verify nothing stuck in processing.
  processing = listJson('processing');
  report('No jobs stuck in processing', processing.length === 0,
    `Expected 0 processing, got ${processing.length}`);
}

async function scenario5_ProcessRestart() {
  console.log('\n--- Scenario 5: Jobs survive process restart ---');
  cleanDb();

  // Enqueue a job.
  run('enqueue \'{"id":"s5-job","command":"echo survived"}\'');

  // Verify it's pending.
  let pending = listJson('pending');
  report('Job is pending', pending.length === 1,
    `Expected 1 pending job, got ${pending.length}`);

  // Start a worker, let it process, stop it.
  const worker = spawnWorker(1);
  await sleep(8000);

  worker.kill();
  await sleep(2000);

  // Check it completed.
  const completed = listJson('completed');
  report('Job completed after restart', completed.length === 1,
    `Expected 1 completed job, got ${completed.length}`);
}

// --- Main ---

async function main() {
  console.log('🧪 queuectl Verification Suite');
  console.log('================================');

  await scenario1_BasicCompletion();
  await scenario2_RetryAndDLQ();
  await scenario3_ConcurrencyExactlyOnce();
  await scenario4_SigkillRecovery();
  await scenario5_ProcessRestart();

  console.log('\n================================');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Verification script error:', err);
  process.exit(1);
});
