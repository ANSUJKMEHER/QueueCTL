'use strict';

const { getDb } = require('../db');
const { setConfig, getConfig } = require('../models/config');

// Only these keys are valid — prevents typos from silently creating garbage rows.
const VALID_KEYS = ['max-retries', 'backoff-base'];

/**
 * Handler for: queuectl config set <key> <value>
 *
 * Sets a global config default. Only affects jobs enqueued *after* this
 * change — existing jobs already have these values snapshotted.
 * See createJob() in models/job.js for the snapshot logic.
 */
function configSetHandler(key, value) {
  if (!VALID_KEYS.includes(key)) {
    console.error(`Error: Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(', ')}`);
    process.exit(1);
  }

  const num = Number(value);
  if (isNaN(num) || num < 0) {
    console.error(`Error: Value must be a non-negative number, got "${value}".`);
    process.exit(1);
  }

  // For max-retries, only accept integers (you can't retry 2.5 times).
  if (key === 'max-retries' && !Number.isInteger(num)) {
    console.error(`Error: max-retries must be an integer, got "${value}".`);
    process.exit(1);
  }

  const db = getDb();
  try {
    setConfig(db, key, value);
    console.log(`Config "${key}" set to ${value}.`);
    console.log('Note: This only affects jobs enqueued after this change.');
  } finally {
    db.close();
  }
}

module.exports = { configSetHandler };
