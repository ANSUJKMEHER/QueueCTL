'use strict';

const { getDb } = require('../db');
const { listJobs, getJobById } = require('../models/job');

/**
 * Handler for: queuectl dlq list [--json]
 *
 * Lists all jobs in the dead-letter queue (state = 'dead').
 */
function dlqListHandler(opts) {
  const db = getDb();

  try {
    const jobs = listJobs(db, { state: 'dead' });

    if (opts && opts.json) {
      console.log(JSON.stringify(jobs));
    } else {
      if (jobs.length === 0) {
        console.log('Dead letter queue is empty.');
        return;
      }

      console.log(`${'ID'.padEnd(20)} ${'ATTEMPTS'.padEnd(10)} ${'COMMAND'.padEnd(30)} LAST ERROR`);
      console.log('-'.repeat(90));
      for (const job of jobs) {
        const errPreview = (job.last_error || '').substring(0, 40);
        console.log(
          `${job.id.padEnd(20)} ${String(job.attempts).padEnd(10)} ${job.command.padEnd(30)} ${errPreview}`
        );
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Handler for: queuectl dlq retry <id>
 *
 * Moves a dead job back to 'pending' with attempts reset to 0.
 *
 * Design choice: resetting attempts to 0 means DLQ retry is a genuine
 * "fresh start" — a human operator explicitly chose to retry this job.
 * Trade-off: max_retries no longer bounds the *lifetime* attempt count,
 * only attempts-since-last-manual-retry. This is documented in DECISIONS.md.
 */
function dlqRetryHandler(id) {
  const db = getDb();

  try {
    const job = getJobById(db, id);

    if (!job) {
      console.error(`Error: Job "${id}" not found.`);
      process.exit(1);
    }

    if (job.state !== 'dead') {
      console.error(`Error: Job "${id}" is in state "${job.state}", not "dead". Only dead jobs can be retried from the DLQ.`);
      process.exit(1);
    }

    const now = new Date().toISOString();

    // Reset to pending with attempts=0 (fresh start).
    // Clear error fields and set next_retry_at to now so it's immediately eligible.
    db.prepare(`
      UPDATE jobs
      SET state = 'pending', attempts = 0, updated_at = ?, next_retry_at = ?,
          last_error = NULL, worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL
      WHERE id = ?
    `).run(now, now, id);

    console.log(`Job "${id}" moved from DLQ back to pending (attempts reset to 0).`);
  } finally {
    db.close();
  }
}

module.exports = { dlqListHandler, dlqRetryHandler };
