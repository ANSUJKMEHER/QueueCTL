'use strict';

const fs = require('fs');
const path = require('path');

// PID files live in a `workers/` directory at the project root.
const WORKERS_DIR = path.join(__dirname, '..', '..', 'workers');

/**
 * Ensure the workers directory exists.
 */
function ensureWorkersDir() {
  if (!fs.existsSync(WORKERS_DIR)) {
    fs.mkdirSync(WORKERS_DIR, { recursive: true });
  }
}

/**
 * Write a PID file for a process.
 * Contains JSON with the PID, start time, and type ('supervisor' or 'worker')
 * so `worker stop` knows which PIDs to signal.
 * Uses writeFileSync for simplicity — this runs once at startup, not in a hot path.
 */
function writePidFile(pid, type = 'worker') {
  ensureWorkersDir();
  const filePath = path.join(WORKERS_DIR, `${pid}.pid`);
  const data = JSON.stringify({ pid, type, startedAt: new Date().toISOString() });
  fs.writeFileSync(filePath, data, 'utf8');
}

/**
 * Remove a PID file when a process exits cleanly.
 */
function removePidFile(pid) {
  const filePath = path.join(WORKERS_DIR, `${pid}.pid`);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    // File might already be gone (e.g., another process cleaned it up).
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Check if a process is alive by sending signal 0.
 * Signal 0 doesn't actually send a signal — it just checks whether
 * the kernel would allow us to send one, which tells us the PID exists.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = "no such process" — the PID is dead.
    // EPERM = "permission denied" — the PID exists but we can't signal it.
    // We treat EPERM as alive (it's running, we just can't touch it).
    return err.code === 'EPERM';
  }
}

/**
 * List all registered processes from PID files, with liveness status.
 * Returns an array of { pid, type, startedAt, alive } objects.
 * type is 'supervisor' or 'worker'.
 */
function listWorkers() {
  ensureWorkersDir();
  const files = fs.readdirSync(WORKERS_DIR).filter(f => f.endsWith('.pid'));
  const workers = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(WORKERS_DIR, file), 'utf8'));
      workers.push({
        pid: data.pid,
        type: data.type || 'worker',
        startedAt: data.startedAt,
        alive: isProcessAlive(data.pid),
      });
    } catch (err) {
      // Corrupted or unreadable PID file — skip it.
      continue;
    }
  }

  return workers;
}

/**
 * Remove PID files for processes that are no longer alive.
 * Called on startup to clean up after crashes.
 */
function cleanStalePidFiles() {
  const workers = listWorkers();
  for (const w of workers) {
    if (!w.alive) {
      removePidFile(w.pid);
    }
  }
}

module.exports = { writePidFile, removePidFile, listWorkers, cleanStalePidFiles, isProcessAlive, WORKERS_DIR };

