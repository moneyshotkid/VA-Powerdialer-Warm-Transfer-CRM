import { get, post, put, del } from './api.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function socialLink(url, label) {
  if (!url) return '';
  const href = escapeHtml(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// --- Tabs ---------------------------------------------------------------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.container > section').forEach((s) => (s.hidden = true));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).hidden = false;
  });
});

// --- Top bar --------------------------------------------------------------
get('/api/auth/me').then((me) => {
  document.getElementById('me-label').textContent = `${me.display_name} (${me.role})`;
});
document.getElementById('logout-btn').addEventListener('click', async () => {
  await post('/api/auth/logout');
  window.location.href = '/index.html';
});

// --- Leads ------------------------------------------------------------
async function loadLeads() {
  const status = document.getElementById('lead-status-filter').value;
  const search = document.getElementById('lead-search').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  const leads = await get(`/api/leads?${params}`);
  const tbody = document.querySelector('#leads-table tbody');
  tbody.innerHTML = leads
    .map(
      (l) => `<tr>
        <td>${escapeHtml(l.company)}</td>
        <td>${escapeHtml(l.category)}</td>
        <td>${escapeHtml(l.city)}</td>
        <td>${socialLink(l.website, l.website) || ''}</td>
        <td><span class="badge ${l.status}">${l.status}</span></td>
        <td>${escapeHtml(l.last_outcome)}</td>
        <td>${l.rating != null ? escapeHtml(l.rating) : ''}</td>
        <td>${l.review_count != null ? escapeHtml(l.review_count) : ''}${l.review_bucket ? ` (${escapeHtml(l.review_bucket)})` : ''}</td>
        <td>${escapeHtml(l.callback_appt)}</td>
        <td>${escapeHtml(l.notes)}</td>
        <td>
          <button data-manage="${l.id}">Manage</button>
          <button data-delete="${l.id}" class="danger">Delete</button>
        </td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('[data-manage]').forEach((btn) => {
    btn.addEventListener('click', () => openLeadForm(Number(btn.dataset.manage)));
  });
  tbody.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteLead(Number(btn.dataset.delete)));
  });
}
document.getElementById('lead-refresh-btn').addEventListener('click', loadLeads);
document.getElementById('lead-status-filter').addEventListener('change', loadLeads);

async function deleteLead(id) {
  if (!window.confirm('Delete this lead? This also permanently deletes its call log history. This cannot be undone.')) return;
  try {
    await del(`/api/leads/${id}`);
    document.getElementById('lead-form').hidden = true;
    document.getElementById('lead-form-empty').hidden = false;
    loadLeads();
  } catch (err) {
    alert(`Could not delete lead: ${err.message}`);
  }
}

document.getElementById('delete-all-leads-btn').addEventListener('click', async () => {
  const typed = window.prompt(
    'This permanently deletes EVERY lead and ALL call log history. This cannot be undone.\n\nType DELETE to confirm:'
  );
  if (typed === null) return; // cancelled
  if (typed !== 'DELETE') {
    alert('Did not match "DELETE" exactly — nothing was deleted.');
    return;
  }
  try {
    const result = await del('/api/leads', { confirm: 'DELETE' });
    document.getElementById('lead-form').hidden = true;
    document.getElementById('lead-form-empty').hidden = false;
    loadLeads();
    alert(`Deleted ${result.deleted} lead(s).`);
  } catch (err) {
    alert(`Could not delete all leads: ${err.message}`);
  }
});

// --- Lead drill-down / manage form ---------------------------------------

const LEAD_FORM_FIELDS = [
  'external_id', 'phone_number', 'name', 'contact_person', 'contact_title', 'email',
  'company', 'address', 'category', 'city', 'website', 'maps_url', 'facebook', 'instagram',
  'linkedin', 'rating', 'review_count', 'review_bucket', 'latest_review_age_days', 'assistant',
  'callback_appt', 'status', 'last_outcome', 'notes',
];

function toDatetimeLocalValue(value) {
  // callback_appt may be stored as "YYYY-MM-DD HH:MM:SS" (from datetime('now')-style writes)
  // or "YYYY-MM-DDTHH:MM" (already what <input type="datetime-local"> expects) — normalize.
  if (!value) return '';
  return value.replace(' ', 'T').slice(0, 16);
}

async function openLeadForm(id) {
  const errorEl = document.getElementById('lead-form-error');
  errorEl.textContent = '';
  try {
    const lead = await get(`/api/leads/${id}`);
    document.getElementById('lead-form-empty').hidden = true;
    document.getElementById('lead-form').hidden = false;
    document.getElementById('lf-id').value = lead.id;
    for (const field of LEAD_FORM_FIELDS) {
      const el = document.getElementById(`lf-${field}`);
      if (!el) continue;
      el.value = field === 'callback_appt' ? toDatetimeLocalValue(lead[field]) : (lead[field] ?? '');
    }
    document.getElementById('lf-is_unclaimed').checked = Boolean(lead.is_unclaimed);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

document.getElementById('lead-form-cancel').addEventListener('click', () => {
  document.getElementById('lead-form').hidden = true;
  document.getElementById('lead-form-empty').hidden = false;
});

document.getElementById('lead-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('lead-form-error');
  errorEl.textContent = '';
  const id = document.getElementById('lf-id').value;
  const payload = {};
  for (const field of LEAD_FORM_FIELDS) {
    const el = document.getElementById(`lf-${field}`);
    if (el) payload[field] = el.value;
  }
  payload.is_unclaimed = document.getElementById('lf-is_unclaimed').checked;

  try {
    await put(`/api/leads/${id}`, payload);
    loadLeads();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById('upload-btn').addEventListener('click', async () => {
  const fileInput = document.getElementById('csv-file');
  const resultEl = document.getElementById('upload-result');
  if (!fileInput.files.length) {
    resultEl.textContent = 'Choose a CSV file first.';
    return;
  }
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('headerless', document.getElementById('csv-headerless').checked ? 'true' : 'false');
  resultEl.textContent = 'Uploading…';
  try {
    const res = await fetch('/api/leads/upload', { method: 'POST', body: formData, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    resultEl.textContent = `Inserted ${data.inserted}, skipped ${data.skipped}.` +
      (data.errors.length ? ` Errors: ${data.errors.map((e) => `row ${e.row}: ${e.reason}`).join('; ')}` : '');
    loadLeads();
  } catch (err) {
    resultEl.textContent = `Error: ${err.message}`;
  }
});

// --- Call logs --------------------------------------------------------
async function loadCallLogs() {
  const rows = await get('/api/leads/call-logs');
  const tbody = document.querySelector('#calllogs-table tbody');
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.started_at)}</td>
        <td>${escapeHtml(r.lead_name)} (${escapeHtml(r.company)})</td>
        <td>${escapeHtml(r.agent_name)}</td>
        <td>${escapeHtml(r.channel)}</td>
        <td>${escapeHtml(r.outcome)}</td>
        <td>${escapeHtml(r.notes)}</td>
        <td>${r.duration_seconds ?? ''}</td>
        <td>${escapeHtml(r.transferred_to)}</td>
      </tr>`
    )
    .join('');
}
document.getElementById('calllog-refresh-btn').addEventListener('click', loadCallLogs);

// --- Users --------------------------------------------------------------
async function loadUsers() {
  const users = await get('/api/users');
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = users
    .map(
      (u) => `<tr>
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.phone_number)}</td>
        <td><button data-edit="${u.id}">Edit</button></td>
      </tr>`
    )
    .join('');
  tbody.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const u = users.find((x) => x.id === Number(btn.dataset.edit));
      document.getElementById('user-id').value = u.id;
      document.getElementById('user-username').value = u.username;
      document.getElementById('user-username').disabled = true;
      document.getElementById('user-display-name').value = u.display_name || '';
      document.getElementById('user-password').value = '';
      document.getElementById('user-role').value = u.role;
      document.getElementById('user-phone').value = u.phone_number || '';
    });
  });
}

document.getElementById('user-form-reset').addEventListener('click', () => {
  document.getElementById('user-form').reset();
  document.getElementById('user-id').value = '';
  document.getElementById('user-username').disabled = false;
});

document.getElementById('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('user-id').value;
  const payload = {
    username: document.getElementById('user-username').value.trim(),
    display_name: document.getElementById('user-display-name').value.trim(),
    password: document.getElementById('user-password').value || undefined,
    role: document.getElementById('user-role').value,
    phone_number: document.getElementById('user-phone').value.trim() || null,
  };
  try {
    if (id) {
      await put(`/api/users/${id}`, payload);
    } else {
      if (!payload.password) throw new Error('Password is required for a new agent');
      await post('/api/users', payload);
    }
    document.getElementById('user-form').reset();
    document.getElementById('user-id').value = '';
    document.getElementById('user-username').disabled = false;
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
});

// --- Settings -------------------------------------------------------------
async function loadSettings() {
  const s = await get('/api/users/settings');
  document.getElementById('transfer-name').value = s.transfer_target_name || '';
  document.getElementById('transfer-phone').value = s.transfer_target_phone || '';
  document.getElementById('vapi-phone-number-id').value = s.vapi_phone_number_id || '';
  const select = document.getElementById('vapi-assistant');
  if (s.vapi_assistant_id && ![...select.options].some((o) => o.value === s.vapi_assistant_id)) {
    const opt = document.createElement('option');
    opt.value = s.vapi_assistant_id;
    opt.textContent = s.vapi_assistant_name || s.vapi_assistant_id;
    select.appendChild(opt);
  }
  select.value = s.vapi_assistant_id || '';
}

document.getElementById('transfer-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await put('/api/users/settings', {
    transfer_target_name: document.getElementById('transfer-name').value.trim(),
    transfer_target_phone: document.getElementById('transfer-phone').value.trim(),
  });
  alert('Saved.');
});

document.getElementById('vapi-load-assistants').addEventListener('click', async () => {
  try {
    const assistants = await get('/api/vapi/assistants');
    const select = document.getElementById('vapi-assistant');
    const current = select.value;
    select.innerHTML = '<option value="">— none —</option>';
    (assistants || []).forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name || a.id;
      select.appendChild(opt);
    });
    select.value = current;
  } catch (err) {
    alert(`Could not load assistants from Vapi: ${err.message}`);
  }
});

document.getElementById('vapi-settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const select = document.getElementById('vapi-assistant');
  await put('/api/users/settings', {
    vapi_assistant_id: select.value,
    vapi_assistant_name: select.selectedOptions[0]?.textContent || '',
    vapi_phone_number_id: document.getElementById('vapi-phone-number-id').value.trim(),
  });
  alert('Saved.');
});

loadLeads();
loadCallLogs();
loadUsers();
loadSettings();
