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
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });
}

function dialIntoConference({ to, role, callLogId }) {
  const client = getClient();
  return client.calls.create({
    to,
    from: process.env.TWILIO_CALLER_ID,
    url: `${baseUrl()}/api/voice/join?role=${role}&callLogId=${callLogId}`,
    statusCallback: `${baseUrl()}/api/voice/call-status?role=${role}&callLogId=${callLogId}`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });
}

function conferenceTwiml(conferenceName, { endConferenceOnExit }) {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit,
      statusCallback: `${baseUrl()}/api/voice/conference-status`,
      statusCallbackEvent: ['start', 'end', 'join', 'leave'],
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
