const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { buildAccessToken } = require('../services/twilioClient');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const token = buildAccessToken(user.twilio_identity);
    res.json({ token, identity: user.twilio_identity });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

module.exports = router;
