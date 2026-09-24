const express = require('express');
const { getSetting } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Lets any authenticated user (not just admins) know which optional dialer channels are
// available, without exposing the full admin settings.
router.get('/', requireAuth, (req, res) => {
  res.json({
    vapiEnabled: Boolean(getSetting('vapi_assistant_id') && getSetting('vapi_phone_number_id')),
    transferConfigured: Boolean(getSetting('transfer_target_phone')),
  });
});

module.exports = router;
