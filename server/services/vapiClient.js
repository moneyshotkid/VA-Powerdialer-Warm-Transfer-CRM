function baseUrl() {
  return (process.env.VAPI_BASE_URL || 'https://api.vapi.ai').replace(/\/+$/, '');
}

function apiKey() {
  const key = process.env.VAPI_API_KEY;
  if (!key) throw new Error('VAPI_API_KEY is not configured.');
  return key;
}

async function vapiFetch(path, options = {}) {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const message = (body && (body.message || body.error)) || res.statusText;
    throw new Error(`Vapi API error (${res.status}): ${JSON.stringify(message)}`);
  }
  return body;
}

function listAssistants() {
  return vapiFetch('/assistant', { method: 'GET' });
}

/**
 * Originate an outbound call handled entirely by Vapi's own telephony. leadId/callLogId are
 * threaded through as call metadata so the webhook can correlate events back to our rows.
 */
function createCall({ assistantId, phoneNumberId, lead, callLogId }) {
  return vapiFetch('/call', {
    method: 'POST',
    body: JSON.stringify({
      assistantId,
      phoneNumberId,
      customer: {
        number: lead.phone_number,
        name: lead.name || lead.contact_person || undefined,
      },
      metadata: {
        leadId: String(lead.id),
        callLogId: String(callLogId),
      },
    }),
  });
}

/** Verify the shared-secret header configured alongside the assistant's Server URL. */
function verifyWebhookSecret(req) {
  const expected = process.env.VAPI_SERVER_SECRET;
  if (!expected) return false;
  const provided = req.get('x-vapi-secret');
  return Boolean(provided) && provided === expected;
}

module.exports = { listAssistants, createCall, verifyWebhookSecret };
