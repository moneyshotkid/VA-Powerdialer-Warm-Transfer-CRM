const express = require('express');
const twilio = require('twilio');
const { db, getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { toE164 } = require('../services/phone');
const { logInfo, logError } = require('../services/logger');
const {
  getClient,
  baseUrl,
  startLeadCall,
  dialIntoConference,
  conferenceTwiml,
} = require('../services/twilioClient');

const router = express.Router();

// Twilio posts application/x-www-form-urlencoded webhooks.
const formParser = express.urlencoded({ extended: false });

function validateTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.get('X-Twilio-Signature');
  const url = `${baseUrl()}${req.originalUrl}`;
  if (!authToken || !signature || !twilio.validateRequest(authToken, signature, url, req.body)) {
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}

function getCallLog(id) {
  return db.prepare('SELECT * FROM call_logs WHERE id = ?').get(id);
}

async function getConferenceSid(callLog) {
  if (callLog.conference_sid) return callLog.conference_sid;
  const client = getClient();
  const conferences = await client.conferences.list({
    friendlyName: callLog.conference_name,
    status: 'in-progress',
    limit: 1,
  });
  if (conferences.length === 0) {
    throw new Error(`Conference ${callLog.conference_name} is not active yet`);
  }
  db.prepare('UPDATE call_logs SET conference_sid = ? WHERE id = ?').run(conferences[0].sid, callLog.id);
  return conferences[0].sid;
}

async function beginLeadDial(callLog) {
  if (callLog.lead_dial_started) return;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(callLog.lead_id);
  if (!lead) return;

  const normalizedPhone = toE164(lead.phone_number);
  if (!normalizedPhone) {
    throw new Error(`Lead #${lead.id}'s phone number "${lead.phone_number}" is not a valid phone number`);
  }

  const leadCall = await startLeadCall(callLog, { ...lead, phone_number: normalizedPhone });
  db.prepare('UPDATE call_logs SET lead_call_sid = ?, lead_dial_started = 1 WHERE id = ?').run(
    leadCall.sid,
    callLog.id
  );
  logInfo('twilio', `Dialing lead #${lead.id} (${normalizedPhone}) into conference`, { callLogId: callLog.id });
}

// ---------------------------------------------------------------------------
// Human-agent call setup (REST, requires an authenticated session)
// ---------------------------------------------------------------------------

// Creates the call_logs row + conference for a human VA's call. For channel='phone' this
// also immediately places the call to the agent's own phone; for channel='browser' the
// frontend follows up with device.connect({ params: { callLogId } }), which lands on
// /api/voice/outbound below.
router.post('/start-call', requireAuth, async (req, res) => {
  const { lead_id, channel } = req.body || {};
  if (!lead_id || !['browser', 'phone'].includes(channel)) {
    return res.status(400).json({ error: 'lead_id and channel ("browser"|"phone") are required' });
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(lead_id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });

  const agent = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  let agentPhone = null;
  if (channel === 'phone') {
    if (!agent.phone_number) {
      return res.status(400).json({ error: 'No "Call My Phone" number is on file for this agent — ask an admin to set one.' });
    }
    agentPhone = toE164(agent.phone_number);
    if (!agentPhone) {
      const message = `Agent ${agent.username}'s "Call My Phone" number "${agent.phone_number}" is not a valid phone number.`;
      logError('twilio', message, { detail: { userId: agent.id } });
      return res.status(400).json({ error: message });
    }
  }

  const conferenceName = `conf_${lead_id}_${Date.now()}`;
  const info = db
    .prepare(
      `INSERT INTO call_logs (lead_id, agent_id, conference_name, channel, status)
       VALUES (?, ?, ?, ?, 'ringing')`
    )
    .run(lead_id, agent.id, conferenceName, channel);
  const callLogId = info.lastInsertRowid;

  try {
    if (channel === 'phone') {
      const call = await dialIntoConference({ to: agentPhone, role: 'va', callLogId });
      db.prepare('UPDATE call_logs SET agent_call_sid = ? WHERE id = ?').run(call.sid, callLogId);
    }
    logInfo('twilio', `Started ${channel} call for lead #${lead_id}`, { callLogId });
    res.status(201).json({ call_log_id: callLogId, conference_name: conferenceName });
  } catch (err) {
    logError('twilio', `Failed to place ${channel} call for lead #${lead_id}: ${err.message}`, { callLogId });
    res.status(502).json({ error: `Failed to place call: ${err.message}`, call_log_id: callLogId });
  }
});

// ---------------------------------------------------------------------------
// Twilio webhooks (signature-validated, no session cookie available)
// ---------------------------------------------------------------------------

router.post('/outbound', formParser, validateTwilioSignature, async (req, res) => {
  const callLogId = req.body.callLogId;
  const callLog = callLogId && getCallLog(callLogId);
  if (!callLog) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, this call could not be connected.');
    res.type('text/xml').send(twiml.toString());
    return;
  }

  db.prepare('UPDATE call_logs SET agent_call_sid = ? WHERE id = ?').run(req.body.CallSid, callLog.id);

  // A WebRTC client leg is effectively "answered" as soon as this TwiML executes (there is
  // no separate ringing phase for the party placing the call), so the lead can be dialed
  // right away. The phone-bridge channel instead waits for /call-status to report the
  // agent's real phone was answered — see beginLeadDial() call there.
  try {
    await beginLeadDial(callLog);
  } catch (err) {
    logError('twilio', `Failed to dial lead for call_log #${callLog.id}: ${err.message}`, { callLogId: callLog.id });
  }

  const twiml = conferenceTwiml(callLog.conference_name, { endConferenceOnExit: false });
  res.type('text/xml').send(twiml.toString());
});

router.all('/join', formParser, validateTwilioSignature, (req, res) => {
  const { role, callLogId } = req.query;
  const callLog = getCallLog(callLogId);
  if (!callLog) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, this call could not be connected.');
    res.type('text/xml').send(twiml.toString());
    return;
  }
  const twiml = conferenceTwiml(callLog.conference_name, { endConferenceOnExit: role !== 'va' });
  res.type('text/xml').send(twiml.toString());
});

router.post('/call-status', formParser, validateTwilioSignature, async (req, res) => {
  const { role, callLogId } = req.query;
  const callLog = getCallLog(callLogId);
  if (!callLog) return res.sendStatus(200);

  const { CallSid, CallStatus, CallDuration } = req.body;
  const sidColumn = role === 'lead' ? 'lead_call_sid' : role === 'admin' ? 'transfer_call_sid' : 'agent_call_sid';
  db.prepare(`UPDATE call_logs SET ${sidColumn} = ? WHERE id = ?`).run(CallSid, callLog.id);

  if (role === 'va' && callLog.channel === 'phone' && ['answered', 'in-progress'].includes(CallStatus)) {
    try {
      await beginLeadDial(getCallLog(callLog.id));
    } catch (err) {
      logError('twilio', `Failed to dial lead for call_log #${callLog.id}: ${err.message}`, { callLogId: callLog.id });
    }
  }

  if (CallStatus === 'completed') {
    db.prepare(
      `UPDATE call_logs SET ended_at = COALESCE(ended_at, datetime('now')), duration_seconds = COALESCE(?, duration_seconds) WHERE id = ?`
    ).run(CallDuration ? parseInt(CallDuration, 10) : null, callLog.id);
  }

  res.sendStatus(200);
});

// ---------------------------------------------------------------------------
// In-call REST controls (requires an authenticated session)
// ---------------------------------------------------------------------------

router.post('/transfer', requireAuth, async (req, res) => {
  const { call_log_id } = req.body || {};
  const callLog = getCallLog(call_log_id);
  if (!callLog) return res.status(404).json({ error: 'Call log not found' });

  const rawTarget = getSetting('transfer_target_phone');
  if (!rawTarget) return res.status(400).json({ error: 'No transfer target phone number is configured.' });
  const transferTarget = toE164(rawTarget);
  if (!transferTarget) {
    const message = `The configured Transfer Target phone number "${rawTarget}" is not valid — fix it in Admin > Settings.`;
    logError('twilio', message, { callLogId: callLog.id });
    return res.status(400).json({ error: message });
  }

  try {
    const call = await dialIntoConference({ to: transferTarget, role: 'admin', callLogId: callLog.id });
    db.prepare('UPDATE call_logs SET transfer_call_sid = ?, transferred_to = ? WHERE id = ?').run(
      call.sid,
      transferTarget,
      callLog.id
    );
    logInfo('twilio', `Warm transfer started for call_log #${callLog.id} -> ${transferTarget}`, { callLogId: callLog.id });
    res.json({ ok: true, transferred_to: transferTarget });
  } catch (err) {
    logError('twilio', `Transfer failed for call_log #${callLog.id}: ${err.message}`, { callLogId: callLog.id });
    res.status(502).json({ error: err.message });
  }
});

router.post('/hold', requireAuth, async (req, res) => {
  const { call_log_id, hold } = req.body || {};
  const callLog = getCallLog(call_log_id);
  if (!callLog || !callLog.lead_call_sid) return res.status(404).json({ error: 'Lead is not yet connected' });

  try {
    const conferenceSid = await getConferenceSid(callLog);
    await getClient().conferences(conferenceSid).participants(callLog.lead_call_sid).update({
      hold: Boolean(hold),
      muted: Boolean(hold),
    });
    res.json({ ok: true, hold: Boolean(hold) });
  } catch (err) {
    logError('twilio', `Hold toggle failed for call_log #${call_log_id}: ${err.message}`, { callLogId: call_log_id });
    res.status(502).json({ error: err.message });
  }
});

router.post('/mute-self', requireAuth, async (req, res) => {
  const { call_log_id, muted } = req.body || {};
  const callLog = getCallLog(call_log_id);
  if (!callLog || !callLog.agent_call_sid) return res.status(404).json({ error: 'Agent leg is not yet connected' });

  try {
    const conferenceSid = await getConferenceSid(callLog);
    await getClient().conferences(conferenceSid).participants(callLog.agent_call_sid).update({ muted: Boolean(muted) });
    res.json({ ok: true, muted: Boolean(muted) });
  } catch (err) {
    logError('twilio', `Mute-self failed for call_log #${call_log_id}: ${err.message}`, { callLogId: call_log_id });
    res.status(502).json({ error: err.message });
  }
});

// Complete Transfer: remove only the VA's own leg from the conference, leaving the lead and
// the transfer target connected. Works the same whether the VA joined by browser or phone.
router.post('/complete-transfer', requireAuth, async (req, res) => {
  const { call_log_id } = req.body || {};
  const callLog = getCallLog(call_log_id);
  if (!callLog || !callLog.agent_call_sid) return res.status(404).json({ error: 'Agent leg is not yet connected' });

  try {
    const conferenceSid = await getConferenceSid(callLog);
    await getClient().conferences(conferenceSid).participants(callLog.agent_call_sid).update({ status: 'completed' });
    logInfo('twilio', `Complete-transfer: VA left call_log #${call_log_id}`, { callLogId: call_log_id });
    res.json({ ok: true });
  } catch (err) {
    logError('twilio', `Complete-transfer failed for call_log #${call_log_id}: ${err.message}`, { callLogId: call_log_id });
    res.status(502).json({ error: err.message });
  }
});

// Plain hangup with no transfer: since the VA's leg is endConferenceOnExit=false, explicitly
// end the whole conference so the lead isn't left stranded on hold.
router.post('/hangup', requireAuth, async (req, res) => {
  const { call_log_id } = req.body || {};
  const callLog = getCallLog(call_log_id);
  if (!callLog) return res.status(404).json({ error: 'Call log not found' });

  try {
    const conferenceSid = await getConferenceSid(callLog).catch(() => null);
    if (conferenceSid) {
      await getClient().conferences(conferenceSid).update({ status: 'completed' });
    }
    logInfo('twilio', `Hangup: ended call_log #${callLog.id}`, { callLogId: callLog.id });
    res.json({ ok: true });
  } catch (err) {
    logError('twilio', `Hangup failed for call_log #${callLog.id}: ${err.message}`, { callLogId: callLog.id });
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
