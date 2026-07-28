'use strict';

const express = require('express');
const path = require('path');
const { getDb } = require('../db');
const { countJobsByState } = require('../models/job');
const { listWorkers } = require('../worker/registry');

function dashboardHandler(opts) {
  const port = opts.port || process.env.PORT || 3000;
  const app = express();

  // Serve static files from the 'public' directory
  app.use(express.static(path.join(__dirname, '../../public')));

  // API endpoint for dashboard stats
  app.get('/api/status', (req, res) => {
    const db = getDb();
    try {
      const counts = countJobsByState(db);
      const workers = listWorkers().filter(w => w.alive);
      
      // Ensure all states are present in the response
      const states = ['pending', 'processing', 'completed', 'failed', 'dead'];
      const jobStats = {};
      for (const state of states) {
        jobStats[state] = counts[state] || 0;
      }

      res.json({
        jobs: jobStats,
        workers: workers.map(w => ({ pid: w.pid, startedAt: w.startedAt }))
      });
    } catch (err) {
      console.error('[dashboard] Error fetching status:', err);
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      db.close();
    }
  });

  app.listen(port, () => {
    console.log(`[dashboard] Web interface running on http://localhost:${port}`);
  });
}

module.exports = { dashboardHandler };
