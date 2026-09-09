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

// Releases a lead this agent claimed but never acted on (no outcome saved) — e.g. clicking
// "Next Lead" to skip one. Without this, claiming leads without releasing them silently
// exhausts a small pool: /next excludes anything locked in the last 5 minutes, so a few
// unreleased claims can make it start returning null even though those leads are still
// "pending" and visible in this same router's peek list above (which doesn't filter locks).
// Scoped to leads locked by the requesting agent so one agent can't release another's claim.
router.post('/release', (req, res) => {
  const { lead_id } = req.body || {};
  if (!lead_id) return res.status(400).json({ error: 'lead_id is required' });
  const info = db
    .prepare(
      `UPDATE leads SET assigned_agent_id = NULL, locked_at = NULL
       WHERE id = ? AND assigned_agent_id = ? AND status = 'pending'`
    )
    .run(lead_id, req.session.userId);
  res.json({ ok: true, released: info.changes > 0 });
});

module.exports = router;
