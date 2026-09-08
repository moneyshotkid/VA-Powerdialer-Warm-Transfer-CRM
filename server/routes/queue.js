const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { claimNextLead } = require('../services/leads');

const router = express.Router();
router.use(requireAuth);

// Peek at the upcoming queue without claiming anything — powers the visual queue list.
router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
  // See services/leads.js claimNextLead() for why this goes through datetime(...) rather
  // than comparing callback_appt against a JS-formatted timestamp as raw strings.
  const leads = db
    .prepare(
      `SELECT * FROM leads
       WHERE status = 'pending'
       ORDER BY
         CASE WHEN callback_appt IS NOT NULL AND datetime(callback_appt) <= datetime('now') THEN 0 ELSE 1 END,
         callback_appt ASC,
         created_at ASC
       LIMIT ?`
    )
    .all(limit);
  res.json(leads);
});

// Claim and return the next lead for the logged-in agent to dial.
router.get('/next', (req, res) => {
  const lead = claimNextLead(req.session.userId);
  if (!lead) return res.json(null);
  res.json(lead);
});

module.exports = router;
