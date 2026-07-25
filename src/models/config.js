'use strict';

/**
 * Config model — reads/writes global defaults from the `config` table.
 * Values are stored as strings; callers are responsible for parsing.
 */

// Hard-coded defaults used when no config row exists yet.
const DEFAULTS = {
  'max-retries': '3',
  'backoff-base': '2',
};

/**
 * Get a config value by key. Returns the stored value, or the hard-coded
 * default if no row exists. This two-tier lookup means the system works
 * out of the box without any `config set` calls.
 */
function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  if (row) return row.value;
  return DEFAULTS[key] || null;
}

/**
 * Set a config value. Uses INSERT OR REPLACE (upsert) so the caller
 * doesn't need to know whether the key already exists.
 */
function setConfig(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = { getConfig, setConfig, DEFAULTS };
