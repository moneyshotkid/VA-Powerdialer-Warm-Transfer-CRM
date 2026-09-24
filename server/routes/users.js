const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting, setSetting } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { toE164 } = require('../services/phone');

const router = express.Router();

// Vapi assistant/phone-number ids are UUIDs — Vapi's own API rejects anything else with a
// fairly opaque "phoneNumberId must be a UUID" error, so catch it here at save time instead,
// pointing the admin at the "Load ... from Vapi" picker rather than typing an id by hand.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USER_FIELDS = 'id, username, role, display_name, twilio_identity, phone_number, created_at';

// All routes here are admin-only: agent identities, the "Call My Phone" number, and the
// transfer-target / Vapi settings are all admin-controlled configuration, not something an
// agent can self-serve.
router.use(requireAdmin);

router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY username`).all());
});

router.post('/', (req, res) => {
  const { username, password, role, display_name, phone_number } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (role && !['admin', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin" or "agent"' });
  }
  let normalizedPhone = null;
  if (phone_number) {
    normalizedPhone = toE164(phone_number);
    if (!normalizedPhone) {
      return res.status(400).json({ error: `"${phone_number}" is not a valid phone number (need E.164, e.g. +15551234567)` });
    }
  }

  const hash = bcrypt.hashSync(password, 10);
  const twilioIdentity = `agent-${username}`;
  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, role, display_name, twilio_identity, phone_number)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(username, hash, role || 'agent', display_name || username, twilioIdentity, normalizedPhone);
    res.status(201).json(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(info.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw err;
  }
});

// NOTE: the /settings routes must be declared before the /:id route below — otherwise
// Express matches "settings" as an :id param on PUT (GET has no conflicting /:id route,
// but keep them together here so this ordering requirement isn't easy to break again).
router.get('/settings', (req, res) => {
  res.json({
    transfer_target_name: getSetting('transfer_target_name', ''),
    transfer_target_phone: getSetting('transfer_target_phone', ''),
    vapi_assistant_id: getSetting('vapi_assistant_id', ''),
    vapi_assistant_name: getSetting('vapi_assistant_name', ''),
    vapi_phone_number_id: getSetting('vapi_phone_number_id', ''),
    vapi_phone_number_label: getSetting('vapi_phone_number_label', ''),
  });
});

router.put('/settings', (req, res) => {
  const {
    transfer_target_name,
    transfer_target_phone,
    vapi_assistant_id,
    vapi_assistant_name,
    vapi_phone_number_id,
    vapi_phone_number_label,
  } = req.body || {};

  if (transfer_target_name !== undefined) setSetting('transfer_target_name', transfer_target_name);
  if (transfer_target_phone !== undefined) {
    const normalized = transfer_target_phone ? toE164(transfer_target_phone) : '';
    if (transfer_target_phone && !normalized) {
      return res.status(400).json({ error: `"${transfer_target_phone}" is not a valid phone number (need E.164, e.g. +15551234567)` });
    }
    setSetting('transfer_target_phone', normalized);
  }
  if (vapi_assistant_id !== undefined) {
    if (vapi_assistant_id && !UUID_RE.test(vapi_assistant_id)) {
      return res.status(400).json({
        error: `"${vapi_assistant_id}" doesn't look like a Vapi assistant id (should be a UUID) — click "Load assistants from Vapi" and pick one from the list instead of typing it in.`,
      });
    }
    setSetting('vapi_assistant_id', vapi_assistant_id);
  }
  if (vapi_assistant_name !== undefined) setSetting('vapi_assistant_name', vapi_assistant_name);
  if (vapi_phone_number_id !== undefined) {
    if (vapi_phone_number_id && !UUID_RE.test(vapi_phone_number_id)) {
      return res.status(400).json({
        error: `"${vapi_phone_number_id}" doesn't look like a Vapi phoneNumberId (should be a UUID) — click "Load phone numbers from Vapi" and pick one from the list instead of typing it in.`,
      });
    }
    setSetting('vapi_phone_number_id', vapi_phone_number_id);
  }
  if (vapi_phone_number_label !== undefined) setSetting('vapi_phone_number_label', vapi_phone_number_label);

  res.json({ ok: true });
});

// Admin-only update — this is the sole write path for phone_number ("Call My Phone" number)
// and role; there is no agent-facing endpoint that can touch these fields.
router.put('/:id', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { display_name, phone_number, role, password } = req.body || {};
  if (role && !['admin', 'agent'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin" or "agent"' });
  }
  let normalizedPhone = phone_number; // undefined -> COALESCE keeps existing; falsy -> also fine
  if (phone_number) {
    normalizedPhone = toE164(phone_number);
    if (!normalizedPhone) {
      return res.status(400).json({ error: `"${phone_number}" is not a valid phone number (need E.164, e.g. +15551234567)` });
    }
  }

  db.prepare(
    `UPDATE users SET
       display_name = COALESCE(?, display_name),
       phone_number = COALESCE(?, phone_number),
       role = COALESCE(?, role)
     WHERE id = ?`
  ).run(display_name, normalizedPhone, role, user.id);

  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), user.id);
  }

  res.json(db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(user.id));
});

module.exports = router;
