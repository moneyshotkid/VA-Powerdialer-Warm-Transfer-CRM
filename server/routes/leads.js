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
  // "headerless" (multipart text field, e.g. "true"/"1" from a checkbox) selects positional
  // column matching for a file with no header row — see services/csv.js parsePositionalCsv.
  const headerless = ['true', '1', 'on'].includes(String(req.body.headerless).toLowerCase());
  try {
    const summary = parseLeadsCsv(req.file.buffer, { headerless });
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

// --- Single-record drill-down (admin "manage all records" form) ----------
// Registered after the literal routes above (/call-logs, /call-status/:x, /outcome, /upload)
// so Express doesn't match those paths as an :id first.

const NUMERIC_LEAD_FIELDS = new Set(['rating', 'review_count', 'latest_review_age_days']);
const BOOLEAN_LEAD_FIELDS = new Set(['is_unclaimed']);
const VALID_STATUSES = new Set(['pending', 'called', 'transferred', 'do_not_call']);

// Every editable leads column except id/created_at/updated_at (server-managed) and
// assigned_agent_id/locked_at (queue-claim bookkeeping, not part of the record itself).
const EDITABLE_LEAD_FIELDS = [
  'external_id', 'phone_number', 'contact_person', 'contact_title', 'email', 'company',
  'address', 'category', 'city', 'website', 'notes', 'name', 'callback_appt', 'assistant',
  'rating', 'review_count', 'review_bucket', 'latest_review_age_days', 'is_unclaimed',
  'maps_url', 'facebook', 'instagram', 'linkedin', 'status', 'last_outcome',
];

function coerceLeadField(field, value) {
  if (value === undefined || value === null || value === '') return null;
  if (NUMERIC_LEAD_FIELDS.has(field)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (BOOLEAN_LEAD_FIELDS.has(field)) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase()) ? 1 : 0;
  }
  return String(value).trim() || null;
}

router.get('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

router.put('/:id', requireAdmin, (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const body = req.body || {};
  const values = {};
  for (const field of EDITABLE_LEAD_FIELDS) {
    values[field] = coerceLeadField(field, body[field]);
  }

  if (!values.phone_number) {
    return res.status(400).json({ error: 'phone_number is required' });
  }
  if (values.status && !VALID_STATUSES.has(values.status)) {
    return res.status(400).json({ error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` });
  }
  // status has no default once a form always submits it, but guard against a blank value
  // wiping the CHECK-constrained column.
  values.status = values.status || lead.status;

  db.prepare(
    `UPDATE leads SET ${EDITABLE_LEAD_FIELDS.map((f) => `${f} = @${f}`).join(', ')}, updated_at = datetime('now')
     WHERE id = @__id`
  ).run({ ...values, __id: lead.id });

  res.json(db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id));
});

module.exports = router;
