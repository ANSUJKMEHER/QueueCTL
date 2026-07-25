'use strict';

const { getConfig } = require('./config');

/**
 * Creates a new job in the database.
 * Snapshots max_retries and backoff_base from config at creation time,
 * unless the caller provides per-job overrides. This means changing
 * global config only affects jobs enqueued *after* the change —
 * simpler to reason about, no retroactive behavior changes.
 */
function createJob(db, { id, command, max_retries, backoff_base }) {
  const now = new Date().toISOString();

  // Snapshot config defaults at creation time.
  // Per-job overrides (if provided) take precedence over global config.
  const maxRetries = max_retries != null ? Number(max_retries) : Number(getConfig(db, 'max-retries'));
  const backoffBase = backoff_base != null ? Number(backoff_base) : Number(getConfig(db, 'backoff-base'));

  db.prepare(`
    INSERT INTO jobs (id, command, state, attempts, max_retries, backoff_base,
                      created_at, updated_at, next_retry_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?, ?, ?)
  `).run(id, command, maxRetries, backoffBase, now, now, now);

  return { id, command, state: 'pending', attempts: 0, max_retries: maxRetries,
           backoff_base: backoffBase, created_at: now, updated_at: now };
}

/**
 * Fetch a single job by ID. Returns the row object or undefined.
 */
function getJobById(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

/**
 * List jobs, optionally filtered by state.
 * Returns an array of job row objects.
 */
function listJobs(db, { state } = {}) {
  if (state) {
    return db.prepare('SELECT * FROM jobs WHERE state = ? ORDER BY created_at').all(state);
  }
  return db.prepare('SELECT * FROM jobs ORDER BY created_at').all();
}

/**
 * Count jobs grouped by state. Returns an object like { pending: 5, completed: 3 }.
 */
function countJobsByState(db) {
  const rows = db.prepare('SELECT state, COUNT(*) as count FROM jobs GROUP BY state').all();
  const counts = {};
  for (const row of rows) {
    counts[row.state] = row.count;
  }
  return counts;
}

module.exports = { createJob, getJobById, listJobs, countJobsByState };
