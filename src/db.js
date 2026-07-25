'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Store the DB file in a `data/` directory next to the project root.
// This keeps the DB out of the source tree while staying portable.
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'queuectl.db');

/**
 * Opens (or creates) the SQLite database and runs schema migrations.
 * Returns a better-sqlite3 Database instance ready for use.
 */
function getDb() {
  // Ensure the data directory exists before SQLite tries to create the file.
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  // WAL mode lets readers proceed while a writer holds the lock.
  // Without this, concurrent workers would block each other on every read.
  db.pragma('journal_mode = WAL');

  // If another process holds the write lock, wait up to 5 seconds
  // before throwing SQLITE_BUSY. This covers brief lock contention
  // between workers during claim queries.
  db.pragma('busy_timeout = 5000');

  runMigrations(db);

  return db;
}

/**
 * Creates tables if they don't already exist.
 * Using IF NOT EXISTS makes this safe to call on every startup —
 * no need for a separate "first run" vs "subsequent run" code path.
 */
function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK(state IN ('pending', 'processing', 'completed', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      backoff_base INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      heartbeat_at TEXT,
      worker_id TEXT,
      next_retry_at TEXT NOT NULL,
      last_error TEXT
    );

    -- This index speeds up the claim query's WHERE + ORDER BY.
    -- Without it, every claim would full-scan the jobs table.
    CREATE INDEX IF NOT EXISTS idx_jobs_claim
      ON jobs(state, next_retry_at, created_at);

    -- Simple key/value store for global defaults (max-retries, backoff-base).
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

module.exports = { getDb, DB_PATH };
