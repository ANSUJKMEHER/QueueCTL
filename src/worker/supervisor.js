'use strict';

/**
 * Supervisor — forks N worker child processes and manages their lifecycle.
 *
 * Responsibilities:
 * - Fork `--count N` child processes, each running loop.js
 * - Write PID files for the supervisor and each child to workers/ directory
 * - Forward SIGTERM/SIGINT to children via IPC { type: 'shutdown' }
 * - Wait for all children to exit, then clean up and exit
 * - Respawn crashed children (unless shutdown is in progress)
 *
 * `worker stop` sends SIGTERM to the supervisor PID. The supervisor's
 * SIGTERM handler then sends IPC shutdown messages to all children.
 * This avoids a race where killing children directly causes the
 * supervisor to respawn them.
 */

const { fork } = require('child_process');
const path = require('path');
const { writePidFile, removePidFile, cleanStalePidFiles } = require('./registry');

const LOOP_PATH = path.join(__dirname, 'loop.js');

/**
 * Start N worker processes and manage them until shutdown.
 * Blocks the calling process (foreground mode).
 */
function startSupervisor(count) {
  // Clean up PID files left behind by previous crashes.
  cleanStalePidFiles();

  // Write the supervisor's own PID file so `worker stop` can find us.
  // Marked as type='supervisor' so `worker stop` knows to signal us
  // (not the children directly — that would cause respawning).
  writePidFile(process.pid, 'supervisor');

  const children = new Map(); // pid → child process
  let shuttingDown = false;

  /**
   * Clean up supervisor PID file on exit.
   */
  function cleanupSupervisor() {
    removePidFile(process.pid);
  }

  /**
   * Fork a single worker child process.
   * Returns the child process object.
   */
  function forkWorker() {
    const child = fork(LOOP_PATH, [], {
      // stdio: 'inherit' connects the child's stdout/stderr to ours,
      // so console.error in loop.js shows up in the terminal.
      // 'ipc' is added automatically by fork() for process.send()/on('message').
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    const pid = child.pid;
    children.set(pid, child);
    writePidFile(pid, 'worker');

    child.on('exit', (code, signal) => {
      children.delete(pid);
      removePidFile(pid);

      if (shuttingDown) {
        console.error(`[supervisor] Worker ${pid} exited (shutdown)`);
      } else {
        // Worker crashed unexpectedly — respawn it.
        // This keeps the worker count stable even if one hits an unhandled error.
        console.error(`[supervisor] Worker ${pid} exited unexpectedly (code=${code}, signal=${signal}), respawning...`);
        forkWorker();
      }

      // If all children have exited and we're shutting down, the supervisor can exit.
      if (shuttingDown && children.size === 0) {
        console.error('[supervisor] All workers stopped. Exiting.');
        cleanupSupervisor();
        process.exit(0);
      }
    });

    console.error(`[supervisor] Forked worker ${pid}`);
    return child;
  }

  /**
   * Signal all children to shut down gracefully.
   * Uses IPC messages (not signals) because the supervisor already has
   * an IPC channel to each child via fork(). The child's loop.js listens
   * for { type: 'shutdown' } and sets its shuttingDown flag.
   */
  function shutdownAll() {
    if (shuttingDown) return; // Prevent double-shutdown
    shuttingDown = true;

    console.error(`[supervisor] Shutting down ${children.size} worker(s)...`);

    for (const [pid, child] of children) {
      try {
        // Send IPC shutdown message. The child will finish its current job,
        // then exit. If the child is between jobs, it exits immediately.
        child.send({ type: 'shutdown' });
      } catch (err) {
        // Child might have already exited between the check and the send.
        console.error(`[supervisor] Failed to send shutdown to ${pid}: ${err.message}`);
      }
    }

    // Safety net: if children don't exit within 30s, force-kill them.
    // This handles the pathological case where a job hangs indefinitely.
    setTimeout(() => {
      if (children.size > 0) {
        console.error(`[supervisor] ${children.size} worker(s) didn't exit in time, force-killing...`);
        for (const [pid, child] of children) {
          try {
            child.kill('SIGKILL');
          } catch (err) {
            // Already dead, ignore.
          }
        }
        cleanupSupervisor();
      }
    }, 30000);
  }

  // Register signal handlers ONCE for the supervisor process.
  // When the user hits Ctrl+C or sends SIGTERM to the supervisor,
  // we forward the shutdown to all children.
  process.on('SIGTERM', shutdownAll);
  process.on('SIGINT', shutdownAll);

  // Fork the requested number of workers.
  console.error(`[supervisor] Starting ${count} worker(s)...`);
  for (let i = 0; i < count; i++) {
    forkWorker();
  }
}

module.exports = { startSupervisor };
