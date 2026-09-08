const express = require('express');
const multer = require('multer');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { parseLeadsCsv, exportCallLogsCsv } = require('../services/csv');
const { applyOutcome, claimNextLead } = require('../services/leads');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

router.post('/upload', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name "file")' });
  try {
    const summary = parseLeadsCsv(req.file.buffer);
    res.json(summary);
  } catch (err) {
    res.status(400).json({ error: `Failed to parse CSV: ${err.message}` });
  }
});

router.get('/', (req, res) => {
  const { status, search } = req.query;
  const clauses = [];
  const params = [];

  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (search) {
    clauses.push('(name LIKE ? OR company LIKE ? OR phone_number LIKE ? OR contact_person LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const leads = db.prepare(`SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT 500`).all(...params);
  res.json(leads);
});

router.get('/call-logs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT cl.*, l.name AS lead_name, l.company, l.phone_number, u.display_name AS agent_name
       FROM call_logs cl
       JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN users u ON u.id = cl.agent_id
       ORDER BY cl.started_at DESC
       LIMIT 500`
    )
    .all();
  res.json(rows);
});

router.get('/call-logs/export', requireAdmin, (req, res) => {
  const csv = exportCallLogsCsv();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="call-logs.csv"');
  res.send(csv);
});

router.get('/call-status/:call_log_id', (req, res) => {
  const row = db.prepare('SELECT * FROM call_logs WHERE id = ?').get(req.params.call_log_id);
  if (!row) return res.status(404).json({ error: 'Call log not found' });
  res.json({
    id: row.id,
    channel: row.channel,
    status: row.status,
    lead_dial_started: Boolean(row.lead_dial_started),
    transferred_to: row.transferred_to,
    outcome: row.outcome,
    notes: row.notes,
    contact_person: row.contact_person,
    contact_title: row.contact_title,
    email: row.email,
    callback_appt: row.callback_appt,
  });
});

router.post('/outcome', (req, res) => {
  const { call_log_id, ...fields } = req.body || {};
  if (!call_log_id) return res.status(400).json({ error: 'call_log_id is required' });

  try {
    const { leadId } = applyOutcome(call_log_id, fields);
    const nextLead = claimNextLead(req.session.userId);
    res.json({ ok: true, leadId, nextLead });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
