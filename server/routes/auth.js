const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Same published defaults rejected at seed time. Checked before the database so a leaked
// hash of admin123 cannot be used even if a row still has it.
const PUBLISHED_PASSWORDS = new Set(['admin123', 'change-me-immediately']);

const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function clientKey(req) {
  return req.ip || 'unknown';
}

function loginBlocked(req) {
  const entry = loginFailures.get(clientKey(req));
  if (!entry) return false;
  if (Date.now() - entry.start > LOGIN_WINDOW_MS) {
    loginFailures.delete(clientKey(req));
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.start > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { start: now, count: 1 });
    return;
  }
  entry.count += 1;
}

router.post('/login', (req, res) => {
  if (loginBlocked(req)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }
  if (PUBLISHED_PASSWORDS.has(password)) {
    recordLoginFailure(req);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(req);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  loginFailures.delete(clientKey(req));
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Login failed' });
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      display_name: user.display_name,
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db
    .prepare('SELECT id, username, role, display_name, twilio_identity, phone_number FROM users WHERE id = ?')
    .get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  res.json(user);
});

module.exports = router;
