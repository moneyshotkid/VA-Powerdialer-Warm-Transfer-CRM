require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

// Initializes the DB file + schema + default admin seed as a side effect of require().
require('./db');

const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const leadsRoutes = require('./routes/leads');
const queueRoutes = require('./routes/queue');
const tokenRoutes = require('./routes/token');
const voiceRoutes = require('./routes/voice');
const vapiRoutes = require('./routes/vapi');
const capabilitiesRoutes = require('./routes/capabilities');
const { requireAuth } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/queue', queueRoutes);
app.use('/api/token', tokenRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api', vapiRoutes); // exposes /api/vapi/assistants, /api/voice/start-vapi-call, /api/webhooks/vapi
app.use('/api/capabilities', capabilitiesRoutes);

// Serve the Twilio Voice JS SDK's browser bundle without a CDN dependency. The package's
// "exports" map only exposes the ESM/CJS module entry points (for bundlers) and blocks
// require.resolve() on any other subpath — including package.json itself — so we go
// straight through node_modules rather than trying to resolve into the package.
app.use(
  '/vendor/twilio.js',
  express.static(path.join(__dirname, '..', 'node_modules', '@twilio', 'voice-sdk', 'dist', 'twilio.min.js'))
);

// Gate the two app shells behind a session so a stale bookmark doesn't leak the UI (the
// underlying data is still protected by the /api/* routes regardless). Must come before
// express.static below, which would otherwise serve these files unconditionally.
app.get('/admin.html', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});
app.get('/agent.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'agent.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error(err);
  if (res.headersSent) return next(err);
  // body-parser (malformed JSON, oversized body) sets a proper status/type on its errors.
  const status = err.statusCode || err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Internal server error' : err.message });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Dialer listening on port ${port}`);
});
