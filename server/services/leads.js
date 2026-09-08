const { db } = require('../db');

const OUTCOME_TO_STATUS = {
  Answered: 'called',
  'No Answer': 'called',
  'Left Voicemail': 'called',
  'Interested/Transferred': 'transferred',
  'Do Not Call': 'do_not_call',
};

const VALID_OUTCOMES = Object.keys(OUTCOME_TO_STATUS);

/**
 * Applies a call outcome to a call_logs row and its parent lead. Shared by the human
 * agent's outcome form (POST /api/leads/outcome) and the Vapi tool-call webhook, so both
 * paths update the CRM identically.
 */
function applyOutcome(callLogId, fields) {
  const callLog = db.prepare('SELECT * FROM call_logs WHERE id = ?').get(callLogId);
  if (!callLog) throw new Error(`call_log ${callLogId} not found`);

  const { outcome, notes, contact_person, contact_title, email, callback_appt } = fields;
  if (outcome && !VALID_OUTCOMES.includes(outcome)) {
    throw new Error(`Invalid outcome "${outcome}"`);
  }

  db.prepare(
    `UPDATE call_logs SET
       outcome = COALESCE(?, outcome),
       notes = COALESCE(?, notes),
       contact_person = COALESCE(?, contact_person),
       contact_title = COALESCE(?, contact_title),
       email = COALESCE(?, email),
       callback_appt = COALESCE(?, callback_appt),
       status = 'completed',
       ended_at = COALESCE(ended_at, datetime('now'))
     WHERE id = ?`
  ).run(outcome, notes, contact_person, contact_title, email, callback_appt, callLogId);

  const newStatus = outcome ? OUTCOME_TO_STATUS[outcome] : undefined;
  db.prepare(
    `UPDATE leads SET
       status = COALESCE(?, status),
       last_outcome = COALESCE(?, last_outcome),
       notes = COALESCE(?, notes),
       contact_person = COALESCE(?, contact_person),
       contact_title = COALESCE(?, contact_title),
       email = COALESCE(?, email),
       callback_appt = COALESCE(?, callback_appt),
       assigned_agent_id = NULL,
       locked_at = NULL,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(newStatus, outcome, notes, contact_person, contact_title, email, callback_appt, callLog.lead_id);

  return { callLog: db.prepare('SELECT * FROM call_logs WHERE id = ?').get(callLogId), leadId: callLog.lead_id };
}

/** Next lead for the queue: callback-due leads first, then plain FIFO. Locks it to the agent. */
function claimNextLead(agentId) {
  // All comparisons run through SQLite's own datetime() so locked_at (written by
  // datetime('now'), space-separated) and callback_appt (written by an HTML
  // datetime-local input, "T"-separated, no seconds) normalize to the same representation
  // instead of being compared as raw strings in two different formats.
  const lead = db
    .prepare(
      `SELECT * FROM leads
       WHERE status = 'pending'
         AND (locked_at IS NULL OR datetime(locked_at) < datetime('now', '-5 minutes'))
       ORDER BY
         CASE WHEN callback_appt IS NOT NULL AND datetime(callback_appt) <= datetime('now') THEN 0 ELSE 1 END,
         callback_appt ASC,
         created_at ASC
       LIMIT 1`
    )
    .get();

  if (!lead) return null;

  db.prepare(
    `UPDATE leads SET assigned_agent_id = ?, locked_at = datetime('now') WHERE id = ?`
  ).run(agentId, lead.id);

  return db.prepare('SELECT * FROM leads WHERE id = ?').get(lead.id);
}

module.exports = { applyOutcome, claimNextLead, VALID_OUTCOMES, OUTCOME_TO_STATUS };
