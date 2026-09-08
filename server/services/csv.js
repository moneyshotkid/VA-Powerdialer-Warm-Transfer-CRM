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

// Fixed column order for "headerless" CSVs — files with no header row at all, so columns
// can only be identified by position. Matches the layout of a specific lead-source export;
// the single `phone` slot maps straight to our phone_number column.
const POSITIONAL_COLUMNS = [
  'company', 'category', 'address', 'city', 'phone_number', 'website', 'email',
  'facebook', 'instagram', 'linkedin', 'rating', 'review_count', 'review_bucket',
  'latest_review_age_days', 'is_unclaimed', 'maps_url',
];

const ALL_LEAD_COLUMNS = Object.values(COLUMN_MAP);

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

/** Trim + coerce one raw CSV cell to the type its target `leads` column expects. */
function coerceValue(column, rawValue) {
  const raw = rawValue ? String(rawValue).trim() : '';
  if (!raw) return null;
  if (NUMERIC_COLUMNS.has(column)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (BOOLEAN_COLUMNS.has(column)) return parseBoolean(raw);
  return raw;
}

function insertMappedRows(mappedRows) {
  const insert = db.prepare(`
    INSERT INTO leads (${ALL_LEAD_COLUMNS.join(', ')})
    VALUES (${ALL_LEAD_COLUMNS.map((c) => `@${c}`).join(', ')})
  `);

  let inserted = 0;
  let skipped = 0;
  const errors = [];

  const run = db.transaction((rows) => {
    rows.forEach(({ rowNum, mapped }) => {
      if (!mapped.phone_number) {
        skipped += 1;
        errors.push({ row: rowNum, reason: 'Missing phone_number' });
        return;
      }
      insert.run(mapped);
      inserted += 1;
    });
  });

  run(mappedRows);
  return { inserted, skipped, errors };
}

/** Default mode: a header row present, columns matched by name (order doesn't matter). */
function parseHeaderedCsv(buffer) {
  const rows = parse(buffer, {
    columns: (headerRow) => headerRow.map(normalizeHeader),
    skip_empty_lines: true,
    trim: true,
  });

  const mappedRows = rows.map((row, index) => {
    const mapped = {};
    for (const [csvKey, column] of Object.entries(COLUMN_MAP)) {
      mapped[column] = coerceValue(column, row[csvKey]);
    }
    return { rowNum: index + 2, mapped }; // +2 accounts for the header row, 1-indexed
  });

  return insertMappedRows(mappedRows);
}

/**
 * "No header row" mode: every row is data, columns identified purely by position per
 * POSITIONAL_COLUMNS. Any lead field not in that list (contact_person, notes, name,
 * callback_appt, assistant, the CSV's own `number`/external_id, …) is left null — still
 * supported via the header-based path above, just not part of this fixed layout.
 */
function parsePositionalCsv(buffer) {
  const rows = parse(buffer, { columns: false, skip_empty_lines: true, trim: true });

  const mappedRows = rows.map((row, index) => {
    const mapped = Object.fromEntries(ALL_LEAD_COLUMNS.map((c) => [c, null]));
    POSITIONAL_COLUMNS.forEach((column, i) => {
      mapped[column] = coerceValue(column, row[i]);
    });
    return { rowNum: index + 1, mapped }; // no header row to skip
  });

  return insertMappedRows(mappedRows);
}

function parseLeadsCsv(buffer, { headerless = false } = {}) {
  return headerless ? parsePositionalCsv(buffer) : parseHeaderedCsv(buffer);
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
