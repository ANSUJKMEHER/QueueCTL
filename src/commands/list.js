'use strict';

const { getDb } = require('../db');
const { listJobs } = require('../models/job');

/**
 * Handler for: queuectl list [--state <state>] [--json]
 *
 * When --json is set, outputs ONLY a JSON array to stdout.
 * This is machine-parsed by the test suite — no debug output to stdout.
 * All informational messages go to stderr via console.error.
 */
function listHandler(opts) {
  const db = getDb();

  try {
    const jobs = listJobs(db, { state: opts.state });

    if (opts.json) {
      // Machine-readable output: ONLY the JSON array, nothing else.
      // The test suite parses this with JSON.parse(stdout).
      console.log(JSON.stringify(jobs));
    } else {
      // Human-readable table.
      if (jobs.length === 0) {
        console.log('No jobs found.');
        return;
      }

      console.log(`${'ID'.padEnd(20)} ${'STATE'.padEnd(12)} ${'ATTEMPTS'.padEnd(10)} ${'COMMAND'.padEnd(30)} CREATED`);
      console.log('-'.repeat(90));
      for (const job of jobs) {
        console.log(
          `${job.id.padEnd(20)} ${job.state.padEnd(12)} ${String(job.attempts).padEnd(10)} ${job.command.padEnd(30)} ${job.created_at}`
        );
      }
    }
  } finally {
    db.close();
  }
}

module.exports = { listHandler };
