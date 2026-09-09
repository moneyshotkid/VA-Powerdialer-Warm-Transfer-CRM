const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

// Admin-only troubleshooting feed — see services/logger.js for what gets written here.
router.get('/', (req, res) => {
  const { level, source, call_log_id, limit } = req.query;
  const clauses = [];
  const params = [];

  if (level) {
    clauses.push('level = ?');
    params.push(level);
  }
  if (source) {
    clauses.push('source = ?');
    params.push(source);
  }
  if (call_log_id) {
    clauses.push('call_log_id = ?');
    params.push(call_log_id);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const lim = Math.min(parseInt(limit, 10) || 200, 1000);
  const rows = db.prepare(`SELECT * FROM logs ${where} ORDER BY id DESC LIMIT ?`).all(...params, lim);
  res.json(rows);
});

module.exports = router;
