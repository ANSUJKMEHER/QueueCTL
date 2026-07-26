'use strict';

const { getDb } = require('../db');
const { createJob } = require('../models/job');

/**
 * Handler for: queuectl enqueue '{"id":"job1","command":"echo hello"}'
 *
 * Parses the JSON string, validates required fields, creates the job.
 * Per-job max_retries and backoff_base overrides are optional —
 * if omitted, current global config defaults are snapshotted.
 */
function enqueueHandler(jsonStr) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Error: Invalid JSON input.');
    process.exit(1);
  }

  if (!parsed.id || !parsed.command) {
    console.error('Error: Job must have "id" and "command" fields.');
    process.exit(1);
  }

  const db = getDb();

  try {
    const job = createJob(db, {
      id: parsed.id,
      command: parsed.command,
      max_retries: parsed.max_retries,
      backoff_base: parsed.backoff_base,
    });

    console.log(`Enqueued job ${job.id} (state: ${job.state}, max_retries: ${job.max_retries}, backoff_base: ${job.backoff_base})`);
  } catch (err) {
    // UNIQUE constraint violation means a job with this ID already exists.
    if (err.message.includes('UNIQUE constraint')) {
      console.error(`Error: Job with id "${parsed.id}" already exists.`);
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }
}

module.exports = { enqueueHandler };
