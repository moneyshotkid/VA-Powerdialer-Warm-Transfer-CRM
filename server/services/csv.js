const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { db } = require('../db');

// CSV header -> leads column. Matching is case-insensitive and ignores surrounding whitespace.
const COLUMN_MAP = {
  number: 'external_id',
  phone_number: 'phone_number',
  contact_person: 'contact_person',
  contact_title: 'contact_title',
  email: 'email',
  company: 'company',
  address: 'address',
  category: 'category',
  city: 'city',
  website: 'website',
  notes: 'notes',
  name: 'name',
  callback_appt: 'callback_appt',
  assistant: 'assistant',
  rating: 'rating',
  review_count: 'review_count',
  review_bucket: 'review_bucket',
  latest_review_age_days: 'latest_review_age_days',
  is_unclaimed: 'is_unclaimed',
  maps_url: 'maps_url',
  facebook: 'facebook',
  instagram: 'instagram',
  linkedin: 'linkedin',
};

// Columns that need type coercion rather than a plain trimmed string.
const NUMERIC_COLUMNS = new Set(['rating', 'review_count', 'latest_review_age_days']);
const BOOLEAN_COLUMNS = new Set(['is_unclaimed']);

const TRUE_VALUES = new Set(['true', 'yes', 'y', '1', 'unclaimed']);
const FALSE_VALUES = new Set(['false', 'no', 'n', '0', 'claimed']);

function normalizeHeader(header) {
  return header.trim().toLowerCase().replace(/\s+/g, '_');
}

function parseBoolean(value) {
  const v = value.toLowerCase();
  if (TRUE_VALUES.has(v)) return 1;
  if (FALSE_VALUES.has(v)) return 0;
  return null;
}

function parseLeadsCsv(buffer) {
  const rows = parse(buffer, {
    columns: (headerRow) => headerRow.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
  });

  const columns = Object.values(COLUMN_MAP);
  const insert = db.prepare(`
    INSERT INTO leads (${columns.join(', ')})
    VALUES (${columns.map((c) => `@${c}`).join(', ')})
  `);

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const insertMany = db.transaction((parsedRows) => {
    parsedRows.forEach((row, index) => {
      const rowNum = index + 2; // account for header row, 1-indexed
      const mapped = {};
      for (const [csvKey, column] of Object.entries(COLUMN_MAP)) {
        const raw = row[csvKey] ? String(row[csvKey]).trim() : '';
        if (!raw) {
          mapped[column] = null;
        } else if (NUMERIC_COLUMNS.has(column)) {
          const n = Number(raw);
          mapped[column] = Number.isFinite(n) ? n : null;
        } else if (BOOLEAN_COLUMNS.has(column)) {
          mapped[column] = parseBoolean(raw);
        } else {
          mapped[column] = raw;
        }
      }

      if (!mapped.phone_number) {
        skipped += 1;
        errors.push({ row: rowNum, reason: 'Missing phone_number' });
        return;
      }

      insert.run(mapped);
      inserted += 1;
    });
  });

  insertMany(rows);

  return { inserted, skipped, errors };
}

function exportCallLogsCsv() {
  const rows = db
    .prepare(
      `SELECT
         cl.id, cl.channel, cl.status, cl.outcome, cl.notes,
         cl.contact_person, cl.contact_title, cl.email, cl.callback_appt,
         cl.transferred_to, cl.started_at, cl.ended_at, cl.duration_seconds,
         l.name AS lead_name, l.company, l.phone_number,
         u.display_name AS agent_name
       FROM call_logs cl
       JOIN leads l ON l.id = cl.lead_id
       LEFT JOIN users u ON u.id = cl.agent_id
       ORDER BY cl.started_at DESC`
    )
    .all();

  return stringify(rows, {
    header: true,
    columns: [
      'id', 'lead_name', 'company', 'phone_number', 'agent_name', 'channel', 'status',
      'outcome', 'notes', 'contact_person', 'contact_title', 'email', 'callback_appt',
      'transferred_to', 'started_at', 'ended_at', 'duration_seconds',
    ],
  });
}

module.exports = { parseLeadsCsv, exportCallLogsCsv };
