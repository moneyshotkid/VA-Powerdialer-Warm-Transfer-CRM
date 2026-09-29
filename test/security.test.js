const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('assert');

const repoRoot = path.resolve(__dirname, '..');
const dbFile = '/tmp/dialer-security-test.sqlite';
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });

process.env.DIALER_DB_PATH = dbFile;
process.env.SESSION_SECRET = 'unit-test-session-secret-value';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'correct-horse-battery';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token-value';
process.env.VAPI_SERVER_SECRET = 'vapi-test-secret';
delete process.env.TWILIO_ACCOUNT_SID;

const { server } = require('../server/index');
const { db } = require('../server/db');
const { exportLeadsCsv, parseLeadsCsv } = require('../server/services/csv');

function listenPort() {
  return new Promise((resolve) => {
    if (server.listening && server.address()) return resolve(server.address().port);
    server.once('listening', () => resolve(server.address().port));
  });
}

function request(port, method, reqPath, { json, form, cookie, headers } = {}) {
  const body = json !== undefined ? JSON.stringify(json) : form;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: {
          ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function sessionCookie(res) {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  assert.ok(first, 'expected a session cookie');
  return first.split(';')[0];
}

test('published defaults are not seeded and an existing admin123 hash rotates', () => {
  const file = '/tmp/dialer-rotate-test.sqlite';
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  const envBase = { ...process.env, DIALER_DB_PATH: file, ADMIN_USERNAME: 'admin' };
  delete envBase.ADMIN_PASSWORD;

  const inserted = spawnSync(
    process.execPath,
    [
      '-e',
      `const bcrypt = require('bcryptjs');
       const { db } = require('./server/db');
       const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
       if (n !== 0) process.exit(2);
       db.prepare("INSERT INTO users (username, password_hash, role, display_name, twilio_identity) VALUES ('admin', ?, 'admin', 'Admin', 'agent-admin')")
         .run(bcrypt.hashSync('admin123', 10));`,
    ],
    { cwd: repoRoot, env: envBase, encoding: 'utf8' }
  );
  assert.equal(inserted.status, 0, inserted.stdout + inserted.stderr);

  const rotated = spawnSync(
    process.execPath,
    [
      '-e',
      `const bcrypt = require('bcryptjs');
       const { db } = require('./server/db');
       const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
       if (!bcrypt.compareSync('rotated-unique-password', row.password_hash)) process.exit(3);
       if (bcrypt.compareSync('admin123', row.password_hash)) process.exit(4);`,
    ],
    { cwd: repoRoot, env: { ...envBase, ADMIN_PASSWORD: 'rotated-unique-password' }, encoding: 'utf8' }
  );
  assert.equal(rotated.status, 0, rotated.stdout + rotated.stderr);
});

test('auth, call ownership, webhooks, and spreadsheet export', async (t) => {
  const port = await listenPort();
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const openToken = await request(port, 'GET', '/api/token');
  assert.equal(openToken.status, 401);
  const openExport = await request(port, 'GET', '/api/leads/export');
  assert.equal(openExport.status, 401);

  const defaultLogin = await request(port, 'POST', '/api/auth/login', {
    json: { username: 'admin', password: 'admin123' },
  });
  assert.equal(defaultLogin.status, 401);

  const login = await request(port, 'POST', '/api/auth/login', {
    json: { username: 'admin', password: 'correct-horse-battery' },
  });
  assert.equal(login.status, 200);
  const adminCookie = sessionCookie(login);
  assert.doesNotMatch(login.headers['set-cookie'].join(';'), /;\s*Secure/i);
  assert.match(login.headers['set-cookie'].join(';'), /HttpOnly/i);

  const created = await request(port, 'POST', '/api/users', {
    cookie: adminCookie,
    json: { username: 'agent1', password: 'agent-pass-1', role: 'agent', display_name: 'Agent One' },
  });
  assert.equal(created.status, 201, created.body);
  const created2 = await request(port, 'POST', '/api/users', {
    cookie: adminCookie,
    json: { username: 'agent2', password: 'agent-pass-2', role: 'agent', display_name: 'Agent Two' },
  });
  assert.equal(created2.status, 201, created2.body);

  const weakUser = await request(port, 'POST', '/api/users', {
    cookie: adminCookie,
    json: { username: 'weak', password: 'admin123', role: 'agent' },
  });
  assert.equal(weakUser.status, 400);

  const agentLogin = await request(port, 'POST', '/api/auth/login', {
    json: { username: 'agent1', password: 'agent-pass-1' },
  });
  const agentCookie = sessionCookie(agentLogin);
  const agent2Login = await request(port, 'POST', '/api/auth/login', {
    json: { username: 'agent2', password: 'agent-pass-2' },
  });
  const agent2Cookie = sessionCookie(agent2Login);

  const agentLeads = await request(port, 'GET', '/api/leads', { cookie: agentCookie });
  assert.equal(agentLeads.status, 403);
  const adminLeads = await request(port, 'GET', '/api/leads', { cookie: adminCookie });
  assert.equal(adminLeads.status, 200);

  const lead = db
    .prepare(`INSERT INTO leads (phone_number, company, notes) VALUES (?, ?, ?)`)
    .run('+15551230000', 'Acme', '=HYPERLINK("http://evil.example")');
  const oldGet = await request(port, 'GET', '/api/queue/next', { cookie: agentCookie });
  assert.equal(oldGet.status, 404);
  const claimed = await request(port, 'POST', '/api/queue/next', { cookie: agentCookie });
  assert.equal(claimed.status, 200, claimed.body);
  assert.equal(JSON.parse(claimed.body).id, Number(lead.lastInsertRowid));

  const stolen = await request(port, 'POST', '/api/voice/start-call', {
    cookie: agent2Cookie,
    json: { lead_id: lead.lastInsertRowid, channel: 'browser' },
  });
  assert.equal(stolen.status, 403, stolen.body);
  const started = await request(port, 'POST', '/api/voice/start-call', {
    cookie: agentCookie,
    json: { lead_id: lead.lastInsertRowid, channel: 'browser' },
  });
  assert.equal(started.status, 201, started.body);
  const callLogId = JSON.parse(started.body).call_log_id;

  const hijack = await request(port, 'POST', '/api/voice/hangup', {
    cookie: agent2Cookie,
    json: { call_log_id: callLogId },
  });
  assert.equal(hijack.status, 403);

  const unsigned = await request(port, 'POST', '/api/voice/outbound', {
    form: `callLogId=${callLogId}&From=client%3Aagent-agent1&CallSid=CA123`,
  });
  assert.equal(unsigned.status, 403);

  const twilio = require('twilio');
  const url = `${process.env.PUBLIC_BASE_URL}/api/voice/outbound`;
  async function signedOutbound(from) {
    const params = { callLogId: String(callLogId), From: from, CallSid: 'CA123' };
    const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params);
    const form = new URLSearchParams(params).toString();
    return request(port, 'POST', '/api/voice/outbound', {
      form,
      headers: { 'X-Twilio-Signature': signature },
    });
  }
  const mismatched = await signedOutbound('client:agent-agent2');
  assert.equal(mismatched.status, 200);
  assert.match(mismatched.body, /could not be connected/);
  assert.doesNotMatch(mismatched.body, /<Conference/);
  const matched = await signedOutbound('client:agent-agent1');
  assert.equal(matched.status, 200, matched.body);
  assert.match(matched.body, /<Conference/);

  const vapiMissing = await request(port, 'POST', '/api/webhooks/vapi', { json: {} });
  assert.equal(vapiMissing.status, 403);
  const vapiOk = await request(port, 'POST', '/api/webhooks/vapi', {
    json: {},
    headers: { 'x-vapi-secret': 'vapi-test-secret' },
  });
  assert.equal(vapiOk.status, 200);

  const exported = exportLeadsCsv();
  assert.match(exported, /'\+15551230000/);
  assert.match(exported, /'=HYPERLINK/);
  const imported = parseLeadsCsv(Buffer.from("phone_number,company\n'+15557654321,Roundtrip\n"));
  assert.equal(imported.inserted, 1, JSON.stringify(imported));
  const stored = db.prepare('SELECT phone_number FROM leads WHERE company = ?').get('Roundtrip');
  assert.equal(stored.phone_number, '+15557654321');

  for (let i = 0; i < 10; i += 1) {
    const failed = await request(port, 'POST', '/api/auth/login', {
      json: { username: 'admin', password: 'not-the-password' },
    });
    assert.equal(failed.status, 401);
  }
  const limited = await request(port, 'POST', '/api/auth/login', {
    json: { username: 'admin', password: 'not-the-password' },
  });
  assert.equal(limited.status, 429);
});
