const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'dialer.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','agent')) DEFAULT 'agent',
  display_name TEXT,
  twilio_identity TEXT UNIQUE,
  phone_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT,
  phone_number TEXT NOT NULL,
  contact_person TEXT,
  contact_title TEXT,
  email TEXT,
  company TEXT,
  address TEXT,
  category TEXT,
  city TEXT,
  website TEXT,
  notes TEXT,
  name TEXT,
  callback_appt TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','called','transferred','do_not_call')) DEFAULT 'pending',
  last_outcome TEXT,
  assigned_agent_id INTEGER REFERENCES users(id),
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  agent_id INTEGER REFERENCES users(id),
  conference_name TEXT,
  conference_sid TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('browser','phone','vapi')),
  agent_call_sid TEXT,
  lead_call_sid TEXT,
  transfer_call_sid TEXT,
  vapi_call_id TEXT,
  transcript TEXT,
  lead_dial_started INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in-progress',
  outcome TEXT,
  notes TEXT,
  contact_person TEXT,
  contact_title TEXT,
  email TEXT,
  callback_appt TEXT,
  transferred_to TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_call_logs_lead_id ON call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_logs_conference_name ON call_logs(conference_name);
CREATE INDEX IF NOT EXISTS idx_call_logs_vapi_call_id ON call_logs(vapi_call_id);
`);

// Seed a default admin if no users exist yet.
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, twilio_identity)
     VALUES (?, ?, 'admin', ?, ?)`
  ).run(username, hash, 'Admin', `agent-${username}`);
  // eslint-disable-next-line no-console
  console.warn(
    `[dialer] Seeded default admin user "${username}". ` +
      (process.env.ADMIN_PASSWORD
        ? ''
        : 'Using fallback password "admin123" — set ADMIN_PASSWORD in .env and change it.')
  );
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

module.exports = { db, getSetting, setSetting };
