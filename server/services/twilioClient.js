const twilio = require('twilio');

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !authToken) {
    throw new Error('Twilio credentials are not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN).');
  }
  return twilio(sid, authToken);
}

function baseUrl() {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error('PUBLIC_BASE_URL is not configured.');
  return url.replace(/\/+$/, '');
}

function buildAccessToken(identity) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    throw new Error(
      'Twilio Access Token is not fully configured (TWILIO_ACCOUNT_SID/TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET/TWILIO_TWIML_APP_SID).'
    );
  }
  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, { identity });
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: false,
  });
  token.addGrant(voiceGrant);
  return token.toJwt();
}

/**
 * Dial the lead's PSTN leg into an already-established conference. Called once the
 * VA's own leg (browser or phone-bridge) has actually answered — see routes/voice.js.
 */
function startLeadCall(callLog, lead) {
  const client = getClient();
  return client.calls.create({
    to: lead.phone_number,
    from: process.env.TWILIO_CALLER_ID,
    url: `${baseUrl()}/api/voice/join?role=lead&callLogId=${callLog.id}`,
    statusCallback: `${baseUrl()}/api/voice/call-status?role=lead&callLogId=${callLog.id}`,
    // Only these two are actually consumed by /api/voice/call-status (an 'answered' VA leg
    // on the phone-bridge channel triggers dialing the lead; 'completed' finalizes
    // duration/timestamps) — 'initiated'/'ringing' were dead weight, and every SID this
    // webhook could tell us is already captured synchronously from this very call's REST
    // response anyway. Trimmed to cut Twilio's webhook volume roughly in half per call leg,
    // which matters on constrained ingress (e.g. a Tailscale Funnel tunnel that can only
    // proxy one or two concurrent requests before bouncing the rest with a 502).
    statusCallbackEvent: ['answered', 'completed'],
  });
}

function dialIntoConference({ to, role, callLogId }) {
  const client = getClient();
  return client.calls.create({
    to,
    from: process.env.TWILIO_CALLER_ID,
    url: `${baseUrl()}/api/voice/join?role=${role}&callLogId=${callLogId}`,
    statusCallback: `${baseUrl()}/api/voice/call-status?role=${role}&callLogId=${callLogId}`,
    // Only these two are actually consumed by /api/voice/call-status (an 'answered' VA leg
    // on the phone-bridge channel triggers dialing the lead; 'completed' finalizes
    // duration/timestamps) — 'initiated'/'ringing' were dead weight, and every SID this
    // webhook could tell us is already captured synchronously from this very call's REST
    // response anyway. Trimmed to cut Twilio's webhook volume roughly in half per call leg,
    // which matters on constrained ingress (e.g. a Tailscale Funnel tunnel that can only
    // proxy one or two concurrent requests before bouncing the rest with a 502).
    statusCallbackEvent: ['answered', 'completed'],
  });
}

function conferenceTwiml(conferenceName, { endConferenceOnExit }) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  // No statusCallback here on purpose: the only thing anything in this app ever read from
  // those events was the conference SID on 'start' — and routes/voice.js's
  // getConferenceSid() already looks that up via a REST call (client.conferences.list())
  // the first time hold/mute/transfer/hangup needs it, caching it from then on. That REST
  // call is outbound from our server to Twilio, so it never touches inbound webhook
  // ingress — unlike this statusCallback, which used to fire up to ~7 times per conference
  // (start + a join/leave per participant + end) for no functional benefit, adding load to
  // constrained ingress (e.g. a Tailscale Funnel tunnel) for nothing.
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit,
    },
    conferenceName
  );
  return twiml;
}

module.exports = {
  getClient,
  baseUrl,
  buildAccessToken,
  startLeadCall,
  dialIntoConference,
  conferenceTwiml,
};
