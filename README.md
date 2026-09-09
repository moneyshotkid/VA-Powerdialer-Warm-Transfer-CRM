# Outbound Power Dialer + CRM

A self-contained Node.js/Express + SQLite app for running an outbound calling campaign with
a VA power-dialer, a Twilio Conference-based warm transfer to an Admin, and an optional AI
assistant (Vapi) dialer channel.

## Features

- **Admin Dashboard**: CSV lead import; a leads table (company, category, city, website,
  status, last outcome, rating, reviews, callback, notes) with status filters and a
  **Manage** drill-down form per lead exposing every stored field for editing; call log &
  analytics table with CSV export; agent user management; warm-transfer target configuration.
- **VA Power Dialer**: visual queue, lead context panel, outcome/notes form with auto-advance,
  Twilio WebRTC controls (mute, hangup, warm transfer, hold/mute the prospect, complete
  transfer).
- **Three calling channels** for the VA's own leg:
  1. **Browser** — Twilio Voice JS SDK (WebRTC) in the agent's browser.
  2. **Call My Phone** — Twilio calls the agent's own phone instead, for a VA whose computer
     has no working mic/speakers. That phone number is set **only by an Admin** (Admin →
     Users), never by the agent.
  3. **AI Assistant (Vapi)** — a configured Vapi AI voice assistant places and conducts the
     call itself; the human operator reviews/finalizes the logged outcome.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — see below
npm run dev
```

The app seeds a default admin user on first boot from `ADMIN_USERNAME`/`ADMIN_PASSWORD`
(fallback `admin`/`admin123` — **change it immediately** if you didn't set those vars).

### Twilio configuration (required for calling)

1. In the Twilio Console, note your **Account SID** and **Auth Token** → `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`.
2. Buy/use a Twilio phone number → `TWILIO_CALLER_ID` (E.164, e.g. `+15551234567`). This is
   used as the caller ID for every outbound leg (lead, phone-bridge VA, transfer target).
3. Create an **API Key** (Console → Account → API keys & tokens) → `TWILIO_API_KEY_SID`,
   `TWILIO_API_KEY_SECRET`. This signs the WebRTC Access Tokens issued by `/api/token`.
4. Create a **TwiML App** (Console → Voice → TwiML Apps) with its **Voice Request URL** set
   to `{PUBLIC_BASE_URL}/api/voice/outbound` (HTTP POST) → `TWILIO_TWIML_APP_SID`.
5. Set `PUBLIC_BASE_URL` to a URL Twilio can reach. In local dev, run a tunnel:
   ```bash
   ngrok http 3000
   ```
   and use the printed `https://…ngrok.io` URL both as `PUBLIC_BASE_URL` and in the TwiML
   App's Voice Request URL above.

Without a reachable `PUBLIC_BASE_URL`, everything except actually ringing a phone works and
can be verified locally (auth, CSV import/export, queue logic, TwiML generation via `curl`).

### Vapi AI assistant configuration (optional)

The "AI Assistant" dialer channel stays hidden until this is set up:

1. Create a Vapi account, an assistant, and provision/import a phone number for it.
2. Set `VAPI_API_KEY` in `.env`.
3. In Admin → Settings → "AI Assistant (Vapi)", click **Load assistants from Vapi**, pick the
   assistant, and enter its phone number's id.
4. On the assistant, add a custom **function tool** named `log_lead_outcome` with parameters
   matching the outcome form: `outcome` (enum: Answered, No Answer, Left Voicemail,
   Interested/Transferred, Do Not Call), `notes`, `contact_person`, `contact_title`, `email`,
   `callback_appt`. Point its Server URL (or the assistant's Server URL, which the tool call
   also goes through) at `{PUBLIC_BASE_URL}/api/webhooks/vapi`, and set a shared secret there
   matching `VAPI_SERVER_SECRET` in `.env`.
5. Before dialing, we also hand the assistant the lead's business details — `company`,
   `address`, `category`, `city`, `website`, `rating`, `review_count`, `review_bucket`,
   `latest_review_age_days`, `is_unclaimed` — via Vapi's `assistantOverrides.variableValues`,
   so the assistant's own system prompt can reference them with `{{company}}`, `{{rating}}`,
   etc. (e.g. *"Hi, I'm calling about {{company}}'s listing on {{website}}…"*). Write the
   assistant's prompt using those placeholders for whichever fields it should mention.
6. Optional: attach Vapi's built-in "transfer call" tool to the assistant, pointed at the
   same number configured as the Warm Transfer Target in Admin → Settings, so the AI can hand
   an interested lead to a human the same way the human-agent channels do. This transfer
   happens entirely inside Vapi's own call — our app only observes and logs it via webhook
   events, it does not orchestrate it.

Exact Vapi field/header names (the call-metadata field, the webhook secret header) should be
double-checked against Vapi's current API reference when wiring this up, since third-party
APIs evolve.

## Known limitations

- Sessions use an in-memory store — fine for a single-instance internal tool, but sessions
  are lost on restart and won't work across multiple server instances.
- No real migration framework — `server/db.js` runs `CREATE TABLE IF NOT EXISTS` plus a
  hand-written list of `ALTER TABLE ADD COLUMN` calls for columns added after the initial
  release (see `LEAD_COLUMNS_V2`). A future column needs the same treatment; anything more
  involved (renames, drops) still needs a manual migration.
- CSV import does not de-duplicate by phone number — re-uploading the same file creates
  duplicate leads.

## Lead CSV columns

**With a header row (default)** — columns matched by name, any order:
```
number, phone_number, contact_person, contact_title, email, company, address, category,
city, website, notes, name, callback_appt, assistant, rating, review_count, review_bucket,
latest_review_age_days, is_unclaimed, maps_url, facebook, instagram, linkedin
```

**Without a header row** — check "This file has no header row" on the upload form; every row
is treated as data and columns are matched strictly by position, in this exact order:
```
company, category, address, city, phone, website, email, facebook, instagram, linkedin,
rating, review_count, review_bucket, latest_review_age_days, is_unclaimed, maps_url
```
Fields outside this list (`contact_person`, `notes`, `name`, `callback_appt`, `assistant`,
the CSV's own `number`/external id) are simply left blank for a positional import — use the
header-row mode instead if a file needs to set those too.

Only `phone_number` is required — rows missing it are rejected and reported in the upload
summary. `rating`/`review_count`/`latest_review_age_days` are parsed as numbers;
`is_unclaimed` accepts `true`/`false`, `yes`/`no`, `1`/`0`, or `claimed`/`unclaimed`
(case-insensitive) and is stored as a boolean. Everything else is stored as plain text.

## Project layout

```
server/           Express app, SQLite schema, Twilio/Vapi integration
public/           Vanilla-JS frontend (login, admin dashboard, VA dialer)
```
