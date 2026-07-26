'use strict';

const { startSupervisor } = require('../worker/supervisor');
const { listWorkers, removePidFile, isProcessAlive } = require('../worker/registry');

/**
 * Handler for: queuectl worker start --count 3
 *
 * Starts the supervisor in the foreground. Blocks until all workers
 * are stopped via SIGTERM/SIGINT or `worker stop`.
 */
function workerStartHandler(opts) {
  const count = parseInt(opts.count, 10);
  if (isNaN(count) || count < 1) {
    console.error('Error: --count must be a positive integer.');
    process.exit(1);
  }
  startSupervisor(count);
}

/**
 * Handler for: queuectl worker stop
 *
 * Reads PID files from the workers/ directory, sends SIGTERM to each
 * live supervisor process. The supervisor's SIGTERM handler forwards
 * the shutdown to its children via IPC. This works from a different
 * terminal — SIGTERM is a real POSIX signal delivered by the kernel.
 *
 * We signal the supervisor (not child workers directly) because
 * killing children directly would cause the supervisor to respawn them.
 */
function workerStopHandler() {
  const workers = listWorkers();

  if (workers.length === 0) {
    console.log('No workers found.');
    return;
  }

  // Find supervisor PIDs — these are the ones we signal.
  // The supervisor handles forwarding shutdown to its children.
  const supervisors = workers.filter(w => w.type === 'supervisor');
  const allPids = workers.filter(w => w.alive);
  let signaled = 0;

  if (supervisors.length === 0) {
    // Fallback: no supervisor PID files found (maybe old PID files).
    // Signal all live PIDs directly.
    console.log('No supervisor PID found. Signaling all live worker PIDs directly.');
    for (const w of allPids) {
      try {
        process.kill(w.pid, 'SIGTERM');
        signaled++;
        console.log(`Sent SIGTERM to PID ${w.pid}`);
      } catch (err) {
        console.error(`Failed to signal PID ${w.pid}: ${err.message}`);
        removePidFile(w.pid);
      }
    }
  } else {
    for (const w of supervisors) {
      if (w.alive) {
        try {
          // Send SIGTERM to the supervisor. On Linux, this is a real signal that
          // the supervisor's process.on('SIGTERM') handler catches, which then
          // sends IPC shutdown messages to all child workers. The children finish
          // their current jobs and exit gracefully.
          process.kill(w.pid, 'SIGTERM');
          signaled++;
          console.log(`Sent SIGTERM to supervisor ${w.pid}`);
        } catch (err) {
          console.error(`Failed to signal supervisor ${w.pid}: ${err.message}`);
          removePidFile(w.pid);
        }
      } else {
        console.log(`Cleaning stale PID file for dead supervisor ${w.pid}`);
        removePidFile(w.pid);
      }
    }
  }

  // Also clean up stale PID files for any dead workers.
  for (const w of workers) {
    if (!w.alive) {
      removePidFile(w.pid);
    }
  }

  if (signaled === 0) {
    console.log('No live workers to stop.');
    return;
  }

  console.log(`Signaled ${signaled} worker(s) to shut down. They will finish current jobs and exit.`);

  // Poll until all workers have exited or timeout (30s).
  // This gives the user feedback that the stop actually worked.
  const start = Date.now();
  const TIMEOUT_MS = 30000;
  const POLL_MS = 1000;

  const pollInterval = setInterval(() => {
    const stillAlive = workers.filter(w => isProcessAlive(w.pid));
    if (stillAlive.length === 0) {
      clearInterval(pollInterval);
      console.log('All workers stopped.');
    } else if (Date.now() - start > TIMEOUT_MS) {
      clearInterval(pollInterval);
      console.error(`Warning: ${stillAlive.length} worker(s) still running after ${TIMEOUT_MS / 1000}s timeout.`);
      console.error('You may need to kill them manually: kill -9 ' + stillAlive.map(w => w.pid).join(' '));
    }
  }, POLL_MS);
}

module.exports = { workerStartHandler, workerStopHandler };
