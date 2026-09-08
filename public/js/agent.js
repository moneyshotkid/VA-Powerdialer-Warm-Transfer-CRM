import { get, post } from './api.js';

const els = {
  meLabel: document.getElementById('me-label'),
  adminLink: document.getElementById('admin-link'),
  channelSelect: document.getElementById('channel-select'),
  channelPhoneOption: document.getElementById('channel-phone-option'),
  channelVapiOption: document.getElementById('channel-vapi-option'),
  deviceStatus: document.getElementById('device-status'),
  startAutoDialBtn: document.getElementById('start-autodial-btn'),
  pauseQueueBtn: document.getElementById('pause-queue-btn'),
  nextLeadBtn: document.getElementById('next-lead-btn'),
  leadEmpty: document.getElementById('lead-empty'),
  leadDetails: document.getElementById('lead-details'),
  leadName: document.getElementById('lead-name'),
  leadCompany: document.getElementById('lead-company'),
  leadCategory: document.getElementById('lead-category'),
  leadAddress: document.getElementById('lead-address'),
  leadPhone: document.getElementById('lead-phone'),
  leadWebsite: document.getElementById('lead-website'),
  leadEmail: document.getElementById('lead-email'),
  leadRating: document.getElementById('lead-rating'),
  leadLatestReview: document.getElementById('lead-latest-review'),
  leadUnclaimed: document.getElementById('lead-unclaimed'),
  leadAssistant: document.getElementById('lead-assistant'),
  leadLinks: document.getElementById('lead-links'),
  leadNotes: document.getElementById('lead-notes'),
  callBtn: document.getElementById('call-btn'),
  muteBtn: document.getElementById('mute-btn'),
  hangupBtn: document.getElementById('hangup-btn'),
  transferBtn: document.getElementById('transfer-btn'),
  holdBtn: document.getElementById('hold-btn'),
  completeTransferBtn: document.getElementById('complete-transfer-btn'),
  callStatus: document.getElementById('call-status'),
  queueList: document.getElementById('queue-list'),
  outcomeForm: document.getElementById('outcome-form'),
  outcomeCallLogId: document.getElementById('outcome-call-log-id'),
};

const state = {
  me: null,
  device: null,
  activeCall: null, // Twilio Voice JS SDK Call object (browser channel only)
  currentLead: null,
  callLogId: null,
  channel: 'browser',
  autoDialing: false,
  muted: false,
  held: false,
  transferred: false,
  pollTimer: null,
};

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatus(text) {
  els.callStatus.textContent = text || '';
}

function socialLink(url, label) {
  if (!url) return '';
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}

function resetCallControls() {
  els.callBtn.disabled = false;
  els.muteBtn.disabled = true;
  els.hangupBtn.disabled = true;
  els.transferBtn.disabled = true;
  els.holdBtn.disabled = true;
  els.completeTransferBtn.disabled = true;
  els.muteBtn.textContent = 'Mute';
  els.holdBtn.textContent = 'Hold Lead';
  state.muted = false;
  state.held = false;
  state.transferred = false;
  stopPolling();
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// --- Bootstrap ------------------------------------------------------------

async function bootstrap() {
  state.me = await get('/api/auth/me');
  els.meLabel.textContent = `${state.me.display_name} (${state.me.role})`;
  if (state.me.role === 'admin') els.adminLink.hidden = false;

  const caps = await get('/api/capabilities');
  if (state.me.phone_number) els.channelPhoneOption.hidden = false;
  if (caps.vapiEnabled) els.channelVapiOption.hidden = false;

  await setupDevice();
  await loadQueueList();
  resetCallControls();
}

async function setupDevice() {
  if (typeof Twilio === 'undefined') {
    setStatus('Twilio Voice SDK failed to load.');
    return;
  }
  try {
    const { token } = await get('/api/token');
    state.device = new Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'] });
    state.device.on('registered', () => { els.deviceStatus.textContent = 'Browser device ready'; });
    state.device.on('error', (err) => { els.deviceStatus.textContent = `Device error: ${err.message}`; });
    await state.device.register();
  } catch (err) {
    els.deviceStatus.textContent = `Browser calling unavailable: ${err.message}`;
  }
}

els.channelSelect.addEventListener('change', () => {
  state.channel = els.channelSelect.value;
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await post('/api/auth/logout');
  window.location.href = '/index.html';
});

// --- Queue ------------------------------------------------------------

async function loadQueueList() {
  const leads = await get('/api/queue?limit=25');
  els.queueList.innerHTML = leads
    .map((l) => `<div class="queue-item">${escapeHtml(l.name || l.contact_person || '(no name)')} — ${escapeHtml(l.company)} — ${escapeHtml(l.phone_number)}</div>`)
    .join('') || '<div class="hint">Queue is empty.</div>';
}

function renderLead(lead) {
  state.currentLead = lead;
  if (!lead) {
    els.leadEmpty.hidden = false;
    els.leadDetails.hidden = true;
    return;
  }
  els.leadEmpty.hidden = true;
  els.leadDetails.hidden = false;
  els.leadName.textContent = lead.name || lead.contact_person || '(no name)';
  els.leadCompany.textContent = lead.company || '';
  els.leadCategory.textContent = lead.category || '—';
  els.leadAddress.textContent = [lead.address, lead.city].filter(Boolean).join(', ') || '—';
  els.leadPhone.textContent = lead.phone_number || '';
  els.leadWebsite.innerHTML = '';
  const websiteLink = lead.website ? socialLink(/^https?:\/\//i.test(lead.website) ? lead.website : `https://${lead.website}`, lead.website) : null;
  if (websiteLink) els.leadWebsite.appendChild(websiteLink);
  else els.leadWebsite.textContent = '—';
  els.leadEmail.textContent = lead.email || '—';
  els.leadNotes.textContent = lead.notes || '';

  els.leadRating.textContent = lead.rating != null
    ? `${lead.rating}★ (${lead.review_count ?? '?'} reviews${lead.review_bucket ? `, ${lead.review_bucket}` : ''})`
    : '—';
  els.leadLatestReview.textContent = lead.latest_review_age_days != null
    ? `${lead.latest_review_age_days} day${lead.latest_review_age_days === 1 ? '' : 's'} ago`
    : '—';
  els.leadUnclaimed.textContent = lead.is_unclaimed == null ? '—' : lead.is_unclaimed ? 'Yes' : 'No';
  els.leadAssistant.textContent = lead.assistant || '—';
  els.leadLinks.innerHTML = '';
  [socialLink(lead.maps_url, 'Maps'), socialLink(lead.facebook, 'Facebook'), socialLink(lead.instagram, 'Instagram'), socialLink(lead.linkedin, 'LinkedIn')]
    .filter(Boolean)
    .forEach((a, i, arr) => {
      els.leadLinks.appendChild(a);
      if (i < arr.length - 1) els.leadLinks.appendChild(document.createTextNode(' · '));
    });
  if (!els.leadLinks.childNodes.length) els.leadLinks.textContent = '—';

  els.outcomeForm.reset();
  document.getElementById('outcome-contact-person').value = lead.contact_person || '';
  document.getElementById('outcome-contact-title').value = lead.contact_title || '';
  document.getElementById('outcome-email').value = lead.email || '';
}

async function claimNextLead() {
  const lead = await get('/api/queue/next');
  renderLead(lead);
  loadQueueList();
  return lead;
}

els.nextLeadBtn.addEventListener('click', async () => {
  resetCallControls();
  await claimNextLead();
});

els.startAutoDialBtn.addEventListener('click', async () => {
  state.autoDialing = true;
  els.startAutoDialBtn.disabled = true;
  els.pauseQueueBtn.disabled = false;
  if (!state.currentLead) {
    const lead = await claimNextLead();
    if (lead) await startCall();
  } else {
    await startCall();
  }
});

els.pauseQueueBtn.addEventListener('click', () => {
  state.autoDialing = false;
  els.startAutoDialBtn.disabled = false;
  els.pauseQueueBtn.disabled = true;
});

// --- Call setup ------------------------------------------------------------

els.callBtn.addEventListener('click', () => startCall());

async function startCall() {
  if (!state.currentLead) {
    setStatus('No lead loaded — click Next Lead first.');
    return;
  }
  els.callBtn.disabled = true;
  setStatus('Starting call…');

  try {
    if (state.channel === 'vapi') {
      const { call_log_id } = await post('/api/voice/start-vapi-call', { lead_id: state.currentLead.id });
      state.callLogId = call_log_id;
      els.outcomeCallLogId.value = call_log_id;
      setStatus('AI Assistant is calling…');
      els.hangupBtn.disabled = true;
      els.muteBtn.disabled = true;
      els.transferBtn.disabled = true;
      els.holdBtn.disabled = true;
      startPolling();
      return;
    }

    const { call_log_id } = await post('/api/voice/start-call', {
      lead_id: state.currentLead.id,
      channel: state.channel,
    });
    state.callLogId = call_log_id;
    els.outcomeCallLogId.value = call_log_id;

    if (state.channel === 'browser') {
      if (!state.device) throw new Error('Browser device is not ready.');
      const call = await state.device.connect({ params: { callLogId: String(call_log_id) } });
      state.activeCall = call;
      setStatus('Connecting…');
      call.on('accept', () => setStatus('Connected — dialing lead…'));
      call.on('disconnect', () => { setStatus('Call ended.'); resetCallControls(); });
      call.on('cancel', () => { setStatus('Call canceled.'); resetCallControls(); });
      call.on('error', (err) => { setStatus(`Call error: ${err.message}`); resetCallControls(); });
      els.muteBtn.disabled = false;
      els.hangupBtn.disabled = false;
      els.transferBtn.disabled = false;
    } else {
      setStatus('Calling your phone…');
      els.muteBtn.disabled = false;
      els.hangupBtn.disabled = false;
      els.transferBtn.disabled = false;
      startPolling();
    }
  } catch (err) {
    setStatus(`Failed to start call: ${err.message}`);
    els.callBtn.disabled = false;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.callLogId) return stopPolling();
    try {
      const s = await get(`/api/leads/call-status/${state.callLogId}`);
      setStatus(`Status: ${s.status}${s.transferred_to ? ` — transferred to ${s.transferred_to}` : ''}`);
      if (state.channel === 'vapi' && s.outcome) {
        prefillOutcomeIfEmpty(s);
      }
    } catch {
      // transient — ignore, will retry on next tick
    }
  }, 2000);
}

function prefillOutcomeIfEmpty(s) {
  const outcomeSelect = document.getElementById('outcome-value');
  if (!outcomeSelect.value && s.outcome) outcomeSelect.value = s.outcome;
  const notes = document.getElementById('outcome-notes');
  if (!notes.value && s.notes) notes.value = s.notes;
  const cp = document.getElementById('outcome-contact-person');
  if (!cp.value && s.contact_person) cp.value = s.contact_person;
}

// --- In-call controls -------------------------------------------------

els.muteBtn.addEventListener('click', async () => {
  state.muted = !state.muted;
  els.muteBtn.textContent = state.muted ? 'Unmute' : 'Mute';
  if (state.channel === 'browser' && state.activeCall) {
    state.activeCall.mute(state.muted);
  } else {
    await post('/api/voice/mute-self', { call_log_id: state.callLogId, muted: state.muted });
  }
});

els.hangupBtn.addEventListener('click', async () => {
  try {
    await post('/api/voice/hangup', { call_log_id: state.callLogId });
  } finally {
    if (state.channel === 'browser' && state.activeCall) state.activeCall.disconnect();
    setStatus('Call ended.');
    resetCallControls();
  }
});

els.transferBtn.addEventListener('click', async () => {
  els.transferBtn.disabled = true;
  try {
    const res = await post('/api/voice/transfer', { call_log_id: state.callLogId });
    setStatus(`Warm transfer in progress — calling ${res.transferred_to}…`);
    els.holdBtn.disabled = false;
    els.completeTransferBtn.disabled = false;
    state.transferred = true;
  } catch (err) {
    setStatus(`Transfer failed: ${err.message}`);
    els.transferBtn.disabled = false;
  }
});

els.holdBtn.addEventListener('click', async () => {
  state.held = !state.held;
  els.holdBtn.textContent = state.held ? 'Unhold Lead' : 'Hold Lead';
  await post('/api/voice/hold', { call_log_id: state.callLogId, hold: state.held });
});

els.completeTransferBtn.addEventListener('click', async () => {
  try {
    await post('/api/voice/complete-transfer', { call_log_id: state.callLogId });
  } finally {
    if (state.channel === 'browser' && state.activeCall) state.activeCall.disconnect();
    setStatus('Transfer complete — you have left the call.');
    resetCallControls();
  }
});

// --- Outcome / auto-advance -------------------------------------------

els.outcomeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.callLogId) {
    setStatus('No active call to log an outcome for.');
    return;
  }
  const payload = {
    call_log_id: state.callLogId,
    outcome: document.getElementById('outcome-value').value,
    notes: document.getElementById('outcome-notes').value,
    contact_person: document.getElementById('outcome-contact-person').value,
    contact_title: document.getElementById('outcome-contact-title').value,
    email: document.getElementById('outcome-email').value,
    callback_appt: document.getElementById('outcome-callback-appt').value || null,
  };
  if (!payload.outcome) {
    setStatus('Select a call outcome first.');
    return;
  }

  try {
    const { nextLead } = await post('/api/leads/outcome', payload);
    resetCallControls();
    state.callLogId = null;
    renderLead(nextLead);
    loadQueueList();
    if (state.autoDialing && nextLead) {
      await startCall();
    } else if (!nextLead) {
      setStatus('Queue is empty.');
    }
  } catch (err) {
    setStatus(`Failed to save outcome: ${err.message}`);
  }
});

bootstrap();
