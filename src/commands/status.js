'use strict';

const { getDb } = require('../db');
const { countJobsByState } = require('../models/job');
const { listWorkers } = require('../worker/registry');

/**
 * Handler for: queuectl status
 *
 * Shows a summary of job state counts and active workers.
 * Human-readable output — not used by automated tests.
 */
function statusHandler() {
  const db = getDb();

  try {
    const counts = countJobsByState(db);
    const workers = listWorkers();
    const liveWorkers = workers.filter(w => w.alive);

    console.log('=== Job Queue Status ===');
    console.log(`  Pending:    ${counts.pending || 0}`);
    console.log(`  Processing: ${counts.processing || 0}`);
    console.log(`  Completed:  ${counts.completed || 0}`);
    console.log(`  Failed:     ${counts.failed || 0}`);
    console.log(`  Dead (DLQ): ${counts.dead || 0}`);
    console.log('');
    console.log(`  Active workers: ${liveWorkers.length}`);

    if (liveWorkers.length > 0) {
      for (const w of liveWorkers) {
        console.log(`    - PID ${w.pid} (started ${w.startedAt})`);
      }
    }
  } finally {
    db.close();
  }
}

module.exports = { statusHandler };
