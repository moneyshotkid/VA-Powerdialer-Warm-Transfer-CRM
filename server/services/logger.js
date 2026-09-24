const { db } = require('../db');

const MAX_LOG_ROWS = 5000;

// Trims the oldest rows once in a while rather than on every write — cheap given this app's
// call volume, and keeps the table from growing unbounded on a long-running deployment.
let writesSinceTrim = 0;

function trim() {
  writesSinceTrim += 1;
  if (writesSinceTrim < 100) return;
  writesSinceTrim = 0;
  db.prepare(
    `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`
  ).run(MAX_LOG_ROWS);
}

/**
 * Admin-visible troubleshooting log — call setup attempts, Twilio/Vapi API failures, and
 * webhook activity. `detail` can be any JSON-serializable value (an error message, a raw
 * webhook payload, request params) and is stored as a JSON string.
 */
function write(level, source, message, { callLogId, detail } = {}) {
  db.prepare(
    `INSERT INTO logs (level, source, message, call_log_id, detail) VALUES (?, ?, ?, ?, ?)`
  ).run(level, source, message, callLogId || null, detail !== undefined ? JSON.stringify(detail) : null);
  trim();

  // Still mirror to the console too, for anyone tailing server output directly.
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  // eslint-disable-next-line no-console
  consoleFn(`[${source || 'app'}] ${message}`, detail !== undefined ? detail : '');
}

module.exports = {
  logInfo: (source, message, opts) => write('info', source, message, opts),
  logWarn: (source, message, opts) => write('warn', source, message, opts),
  logError: (source, message, opts) => write('error', source, message, opts),
};
