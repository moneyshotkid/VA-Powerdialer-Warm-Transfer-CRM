const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Numbers without an explicit country code (e.g. a plain "555-123-4567" from a CSV) are
// assumed to be in this region. Override via DEFAULT_PHONE_COUNTRY in .env for non-US data.
const DEFAULT_COUNTRY = process.env.DEFAULT_PHONE_COUNTRY || 'US';

/**
 * Normalizes a phone number to E.164 (e.g. "+15551234567") — the format Twilio and Vapi
 * both require for `to`/`customer.number`. Returns null if the input isn't a parseable,
 * valid number, so callers can distinguish "missing" from "present but invalid".
 */
function toE164(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, DEFAULT_COUNTRY);
    // isPossible() (length/structure) rather than isValid() (real assigned ranges) —
    // isValid() rejects the "555" area code commonly used for test/demo data even though
    // Twilio and Vapi will happily dial it; we only need to catch actual garbage input.
    return parsed && parsed.isPossible() ? parsed.number : null;
  } catch {
    return null;
  }
}

module.exports = { toE164 };
