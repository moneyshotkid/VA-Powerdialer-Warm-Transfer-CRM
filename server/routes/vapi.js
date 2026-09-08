const express = require('express');
const { db, getSetting } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { applyOutcome } = require('../services/leads');
const vapiClient = require('../services/vapiClient');

const router = express.Router();

router.get('/assistants', requireAdmin, async (req, res) => {
  try {
    const assistants = await vapiClient.listAssistants();
    res.json(assistants);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Places an outbound call entirely on Vapi's own telephony — this never touches our Twilio
// conference. Gated on an admin having picked an assistant + phone number in Settings.
router.post('/voice/start-vapi-call', requireAuth, async (req, res) => {
  const { lead_id } = req.body || {};
  const assistantId = getSetting('vapi_assistant_id');
  const phoneNumberId = getSetting('vapi_phone_number_id');
  if (!assistantId || !phoneNumberId) {
    return res.status(400).json({ error: 'AI Assistant calling is not configured yet — set it up in Admin Settings.' });
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const info = db
    .prepare(
      `INSERT INTO call_logs (lead_id, agent_id, channel, status)
       VALUES (?, ?, 'vapi', 'ringing')`
    )
    .run(lead_id, req.session.userId);
  const callLogId = info.lastInsertRowid;

  try {
    const call = await vapiClient.createCall({ assistantId, phoneNumberId, lead, callLogId });
    db.prepare('UPDATE call_logs SET vapi_call_id = ? WHERE id = ?').run(call.id, callLogId);
    res.status(201).json({ call_log_id: callLogId, vapi_call_id: call.id });
  } catch (err) {
    res.status(502).json({ error: `Failed to start Vapi call: ${err.message}`, call_log_id: callLogId });
  }
});

// Single Server URL configured on the Vapi assistant. Handles status updates, the end-of-call
// report, and the log_lead_outcome tool call the assistant makes to record the outcome.
router.post('/webhooks/vapi', express.json(), (req, res) => {
  if (!vapiClient.verifyWebhookSecret(req)) {
    return res.status(403).json({ error: 'Invalid or missing Vapi webhook secret' });
  }

  const message = (req.body && req.body.message) || {};
  const callLogId = findCallLogId(message);

  switch (message.type) {
    case 'status-update':
      if (callLogId) {
        db.prepare('UPDATE call_logs SET status = ? WHERE id = ?').run(message.status || 'in-progress', callLogId);
      }
      return res.sendStatus(200);

    case 'end-of-call-report': {
      if (callLogId) {
        const transcript = message.transcript || message.summary || null;
        const duration = message.durationSeconds || message.call?.durationSeconds || null;
        db.prepare(
          `UPDATE call_logs SET transcript = COALESCE(?, transcript), ended_at = datetime('now'), duration_seconds = COALESCE(?, duration_seconds) WHERE id = ?`
        ).run(transcript, duration, callLogId);
      }
      return res.sendStatus(200);
    }

    case 'tool-calls': {
      const toolCalls = message.toolCallList || message.toolWithToolCallList || [];
      const results = toolCalls.map((entry) => {
        const toolCall = entry.toolCall || entry;
        const name = entry.name || toolCall.name;
        const toolCallId = toolCall.id;
        if (name === 'log_lead_outcome' && callLogId) {
          try {
            applyOutcome(callLogId, toolCall.arguments || toolCall.parameters || {});
            return { toolCallId, result: 'logged' };
          } catch (err) {
            return { toolCallId, result: `error: ${err.message}` };
          }
        }
        return { toolCallId, result: 'ignored: unknown tool' };
      });
      return res.json({ results });
    }

    default:
      return res.sendStatus(200);
  }
});

function findCallLogId(message) {
  const metadata = message.call?.metadata || message.metadata;
  if (metadata && metadata.callLogId) return metadata.callLogId;
  if (message.call?.id) {
    const row = db.prepare('SELECT id FROM call_logs WHERE vapi_call_id = ?').get(message.call.id);
    if (row) return row.id;
  }
  return null;
}

module.exports = router;
