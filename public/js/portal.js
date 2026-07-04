import { api, esc, timeAgo, fmtTime, loadConfig, CONFIG, incidentMeta, SEV_CLASS } from '/js/common.js';

const socket = io();
const state = { drones: [], alerts: [], dispatches: [], mf: [], pendingTarget: null, liveDroneId: null };

// ---------- boot ----------
init();
async function init() {
  await loadConfig();
  const badge = document.getElementById('aiBadge');
  badge.textContent = `AI: ${CONFIG.aiLabel || 'Simulation'}`;
  badge.className = 'badge ' + (CONFIG.aiMode === 'mock' ? 'mock' : 'live');

  const sel = document.getElementById('d_type');
  sel.innerHTML = Object.entries(CONFIG.incidentTypes)
    .filter(([k]) => k !== 'normal')
    .map(([k, v]) => `<option value="${k}" ${k === 'suspicious_activity' ? 'selected' : ''}>${v.icon} ${esc(v.label)}</option>`)
    .join('');

  setupTabs();
  setupDispatchForm();
  setupModal();
  setupLiveModal();
  setupClearModal();
  document.getElementById('resetBtn').onclick = async () => {
    if (confirm('Clear all alerts, dispatches and logs? (drones are kept)')) await api('/api/admin/reset', { method: 'POST' });
  };

  wireSocket();
  socket.emit('police:join');
  await Promise.all([refreshDrones(), refreshAlerts(), refreshDispatches(), refreshMF()]);
  setStats(await api('/api/stats'));
  setInterval(() => { renderAlerts(); renderDispatches(); renderMF(); }, 30000); // refresh "x ago"
}

function wireSocket() {
  socket.on('stats', setStats);
  socket.on('drone:status', () => refreshDrones());
  socket.on('alert:new', (a) => { refreshAlerts(); toast(a); beep(); });
  socket.on('alert:updated', () => refreshAlerts());
  socket.on('dispatch:new', (d) => { refreshDispatches(); toast({ incidentType: d.incidentType, title: 'Drones dispatched', interpretation: `${d.assignedDrones.length} drones surrounding ${d.address || 'target'}`, sector: d.address }); });
  socket.on('dispatch:frame', ({ dispatchId, frame }) => onFrame(dispatchId, frame));
  socket.on('dispatch:updated', () => refreshDispatches());
  socket.on('dispatch:resolved', () => { refreshDispatches(); refreshDrones(); });
  socket.on('mainforce:new', () => refreshMF());
  socket.on('live:frame', onLiveFrame);
  socket.on('refresh', () => { refreshDrones(); refreshAlerts(); refreshDispatches(); refreshMF(); });
}

// ---------- data refresh ----------
async function refreshDrones() { state.drones = await api('/api/drones'); renderMap(); renderDroneList(); }
async function refreshAlerts() { state.alerts = await api('/api/alerts'); renderAlerts(); renderMap(); }
async function refreshDispatches() { state.dispatches = await api('/api/dispatches'); renderDispatches(); renderMap(); }
async function refreshMF() { state.mf = await api('/api/mainforce'); renderMF(); }

function onFrame(dispatchId, frame) {
  const d = state.dispatches.find((x) => x.id === dispatchId);
  if (!d) { refreshDispatches(); return; }
  d.frames.push(frame);
  if (d.frames.length > 16) d.frames = d.frames.slice(-16);
  renderDispatches();
}

// ---------- stats ----------
function setStats(s) {
  document.getElementById('s_drones').textContent = `${s.dronesOnline}/${s.dronesTotal}`;
  document.getElementById('s_pending').textContent = s.pendingAlerts;
  document.getElementById('s_escalated').textContent = s.escalated;
  document.getElementById('s_dismissed').textContent = s.dismissed;
  document.getElementById('s_dispatch').textContent = s.activeDispatches;
  document.getElementById('s_mf').textContent = s.mainForce;
  const pill = document.getElementById('pill_alerts');
  if (s.pendingAlerts > 0) { pill.style.display = ''; pill.textContent = s.pendingAlerts; }
  else pill.style.display = 'none';
}

// ---------- tabs ----------
function setupTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'map') renderMap();
    };
  });
}

// ---------- alerts ----------
function alertCard(a, reviewed) {
  const m = incidentMeta(a.incidentType);
  const conf = Math.round((a.confidence || 0) * 100);
  const img = a.imageUrl
    ? `<img class="thumb" src="${a.imageUrl}" alt="frame" />`
    : `<div class="thumb placeholder">${m.icon}</div>`;
  const status = reviewed
    ? `<span class="chip">${a.status === 'escalated' ? '📣 Escalated to main force' : '✅ Dismissed'}</span>`
    : '';
  const actions = reviewed
    ? (a.reviewNote ? `<div class="meta">Note: “${esc(a.reviewNote)}” — ${esc(a.reviewedBy || '')}</div>` : `<div class="meta">by ${esc(a.reviewedBy || '')}</div>`)
    : `<div class="actions">
         <button class="btn danger" data-esc="${a.id}">📣 Escalate to Main Force</button>
         <button class="btn primary" data-dis="${a.id}">✅ Situation OK — Resume</button>
       </div>`;
  return `<div class="card">
    ${img}
    <div class="body">
      <div class="row">
        <span class="sev ${SEV_CLASS[a.severity] || 'sev-medium'}">${esc(a.severity)}</span>
        <h3>${m.icon} ${esc(a.title)}</h3>
      </div>
      <div class="meta">🚁 ${esc(a.droneName)} · ${esc(a.sector)} · ${timeAgo(a.timestamp)} · <span class="chip">${a.source === 'claude-vision' ? 'Claude Vision' : 'Simulated'}</span></div>
      <div class="interp">🤖 “${esc(a.interpretation)}”</div>
      <div class="meta">Suggested: ${esc(a.recommendedAction)}</div>
      <div class="row"><span class="meta" style="width:70px">Confidence</span><div class="conf-bar" style="flex:1"><span style="width:${conf}%"></span></div><span class="meta">${conf}%</span></div>
      ${status}
      ${actions}
    </div>
  </div>`;
}

function renderAlerts() {
  const pending = state.alerts.filter((a) => a.status === 'pending_review');
  const reviewed = state.alerts.filter((a) => a.status !== 'pending_review');
  const p = document.getElementById('alertsPending');
  const h = document.getElementById('alertsHistory');
  p.innerHTML = pending.length ? pending.map((a) => alertCard(a, false)).join('') : `<div class="empty">No pending alerts. Drones are monitoring…</div>`;
  h.innerHTML = reviewed.length ? reviewed.map((a) => alertCard(a, true)).join('') : `<div class="empty">Nothing reviewed yet.</div>`;
  p.querySelectorAll('[data-esc]').forEach((b) => (b.onclick = () => reviewAlert(b.dataset.esc, 'escalate')));
  p.querySelectorAll('[data-dis]').forEach((b) => (b.onclick = () => reviewAlert(b.dataset.dis, 'dismiss')));
}

function reviewAlert(id, kind) {
  const a = state.alerts.find((x) => x.id === id);
  if (!a) return;
  const escalate = kind === 'escalate';
  openModal({
    title: escalate ? '📣 Escalate to Main Force' : '✅ Dismiss — Resume Monitoring',
    desc: escalate
      ? `Confirm this is a real "${incidentMeta(a.incidentType).label}" and send it to the main police force.`
      : `Mark this as not needing police help. The drone will resume monitoring.`,
    okLabel: escalate ? 'Escalate' : 'Dismiss',
    onOk: async (note) => {
      await api(`/api/alerts/${id}/${escalate ? 'escalate' : 'dismiss'}`, {
        method: 'POST',
        body: { officer: 'Drone Police Officer', note }
      });
    }
  });
}

// ---------- dispatch ----------
const DISPATCH_PRESETS = [
  { icon: '💍', label: 'Jewellery robbery', type: 'theft_robbery', desc: 'Armed robbery reported at a jewellery shop.' },
  { icon: '🏦', label: 'Bank robbery', type: 'theft_robbery', desc: 'Robbery in progress at a bank.' },
  { icon: '🔫', label: 'Armed person', type: 'weapon_threat', desc: 'Armed person threatening people at the location.' },
  { icon: '🧑‍🤝‍🧑', label: 'Kidnapping', type: 'suspicious_activity', desc: 'Possible abduction / kidnapping reported.' },
  { icon: '💣', label: 'Bomb threat', type: 'abandoned_object', desc: 'Suspicious package / bomb threat reported.' },
  { icon: '🥊', label: 'Violence', type: 'violence_assault', desc: 'Violent assault / fight reported.' },
  { icon: '🔥', label: 'Fire', type: 'building_fire', desc: 'Building fire reported at the location.' }
];

function setupDispatchForm() {
  // Known-location dropdown → fills address + coordinates by name.
  const place = document.getElementById('d_place');
  place.innerHTML =
    '<option value="">— pick a known location —</option>' +
    (CONFIG.landmarks || []).map((l, i) => `<option value="${i}">${esc(l.name)}</option>`).join('');
  place.onchange = () => {
    const l = (CONFIG.landmarks || [])[place.value];
    if (!l) return;
    document.getElementById('d_addr').value = l.name;
    document.getElementById('d_lat').value = l.lat.toFixed(5);
    document.getElementById('d_lng').value = l.lng.toFixed(5);
    state.pendingTarget = { lat: l.lat, lng: l.lng };
    renderMap();
  };

  // Quick emergency-report presets → fill incident type + details.
  const row = document.getElementById('presetRow');
  row.innerHTML = DISPATCH_PRESETS.map(
    (p, i) => `<button class="btn sm" data-preset="${i}">${p.icon} ${esc(p.label)}</button>`
  ).join('');
  row.querySelectorAll('[data-preset]').forEach(
    (b) =>
      (b.onclick = () => {
        const p = DISPATCH_PRESETS[b.dataset.preset];
        document.getElementById('d_type').value = p.type;
        document.getElementById('d_desc').value = p.desc;
        b.blur();
      })
  );

  document.getElementById('d_send').onclick = async () => {
    const lat = parseFloat(document.getElementById('d_lat').value);
    const lng = parseFloat(document.getElementById('d_lng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      alert('Pick a location first — choose a known location, click the Fleet Map, or type coordinates.');
      return;
    }
    try {
      await api('/api/dispatches', {
        method: 'POST',
        body: {
          lat,
          lng,
          address: document.getElementById('d_addr').value,
          incidentType: document.getElementById('d_type').value,
          description: document.getElementById('d_desc').value,
          officer: 'Main Force'
        }
      });
      document.getElementById('d_addr').value = '';
      document.getElementById('d_desc').value = '';
      document.getElementById('d_lat').value = '';
      document.getElementById('d_lng').value = '';
      document.getElementById('d_place').value = '';
      state.pendingTarget = null;
      renderMap();
    } catch (e) {
      alert('Dispatch failed: ' + e.message);
    }
  };
}

function dispatchCard(d) {
  const active = d.status === 'active';
  const latestByDrone = {};
  for (const f of d.frames) latestByDrone[f.droneId] = f;
  const tiles = d.assignedDrones
    .map((ad) => {
      const f = latestByDrone[ad.id];
      if (f) {
        return `<div class="frame-tile"><img src="${f.url}" alt="live" /><span class="live">● LIVE</span><span class="lbl">${esc(ad.name)}</span></div>`;
      }
      return `<div class="frame-tile sim-tile"><div class="scan"></div>🚁<div>${esc(ad.name)}</div><div>surrounding…</div></div>`;
    })
    .join('');
  const m = incidentMeta(d.incidentType);
  const updates = d.updates && d.updates.length
    ? `<div class="meta" style="margin-top:8px">Conveyed to main force:</div>` +
      d.updates.map((u) => `<div class="meta">• “${esc(u.info)}” — ${esc(u.officer)} (${fmtTime(u.at)})</div>`).join('')
    : '';
  return `<div class="disp-card">
    <div class="disp-head">
      <span class="sev ${active ? 'sev-critical' : 'sev-none'}">${active ? 'ACTIVE' : 'RESOLVED'}</span>
      <h3 style="margin:0">${m.icon} ${esc(m.label)}</h3>
      <span class="meta">${esc(d.address || d.lat.toFixed(4) + ', ' + d.lng.toFixed(4))} · ${timeAgo(d.timestamp)}</span>
    </div>
    ${d.description ? `<div class="interp" style="margin-top:6px">“${esc(d.description)}”</div>` : ''}
    <div class="row" style="margin-top:8px">${d.assignedDrones.map((a) => `<span class="chip">🚁 ${esc(a.name)} · ${a.distanceKm}km</span>`).join('')}</div>
    <div class="footage">${tiles}</div>
    ${updates}
    ${active ? `<div class="row" style="margin-top:12px; gap:8px">
        <input id="conv_${d.id}" placeholder="Convey info to main force (e.g. 2 suspects, north exit)" style="flex:1" />
        <button class="btn warn" data-convey="${d.id}">Convey</button>
        <button class="btn primary" data-resolve="${d.id}">Resolve</button>
      </div>` : ''}
  </div>`;
}

function renderDispatches() {
  const wrap = document.getElementById('dispatchList');
  // Live footage frames re-render this list every second — preserve any convey
  // text the officer is typing (value, focus and cursor position).
  const saved = {};
  wrap.querySelectorAll('input[id^="conv_"]').forEach((i) => (saved[i.id] = i.value));
  const focused = document.activeElement;
  const focusInfo =
    focused && focused.id && focused.id.startsWith('conv_')
      ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd }
      : null;

  const list = state.dispatches;
  wrap.innerHTML = list.length ? list.map(dispatchCard).join('') : `<div class="empty">No dispatches yet. Enter a location to send drones.</div>`;

  for (const [id, val] of Object.entries(saved)) {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  }
  if (focusInfo) {
    const el = document.getElementById(focusInfo.id);
    if (el) {
      el.focus();
      try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch {}
    }
  }
  wrap.querySelectorAll('[data-resolve]').forEach((b) => (b.onclick = () => api(`/api/dispatches/${b.dataset.resolve}/resolve`, { method: 'POST' })));
  wrap.querySelectorAll('[data-convey]').forEach((b) => (b.onclick = async () => {
    const inp = document.getElementById('conv_' + b.dataset.convey);
    if (!inp.value.trim()) return;
    await api(`/api/dispatches/${b.dataset.convey}/convey`, { method: 'POST', body: { info: inp.value, officer: 'Drone Police Officer' } });
    inp.value = '';
  }));
}

// ---------- main force ----------
function renderMF() {
  const wrap = document.getElementById('mfList');
  wrap.innerHTML = state.mf.length
    ? state.mf.map((r) => {
        const m = incidentMeta(r.incidentType);
        return `<div class="log-item">
          <div class="t">${new Date(r.timestamp).toLocaleString()} · ${r.sourceType === 'alert' ? 'Escalation' : 'Field update'} · by ${esc(r.officer)}</div>
          <div style="margin-top:4px"><b>${m.icon} ${esc(r.title)}</b> — ${esc(r.location)} · 🚁 ${esc(r.droneName || '')}</div>
          <div class="interp" style="margin-top:4px">“${esc(r.conveyed)}”</div>
        </div>`;
      }).join('')
    : `<div class="empty">Nothing has been sent to the main force yet.</div>`;
}

// ---------- map ----------
let bounds = null;
function computeBounds() {
  const pts = state.drones.map((d) => ({ lat: d.lat, lng: d.lng }));
  const c = CONFIG.cityCenter;
  pts.push({ lat: c.lat, lng: c.lng });
  let minLat = Math.min(...pts.map((p) => p.lat)), maxLat = Math.max(...pts.map((p) => p.lat));
  let minLng = Math.min(...pts.map((p) => p.lng)), maxLng = Math.max(...pts.map((p) => p.lng));
  const padLat = (maxLat - minLat) * 0.25 || 0.01;
  const padLng = (maxLng - minLng) * 0.25 || 0.01;
  bounds = { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng };
}
const PAD = 40, W = 1000, H = 520;
function project(lat, lng) {
  const x = PAD + ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * (W - 2 * PAD);
  const y = PAD + ((bounds.maxLat - lat) / (bounds.maxLat - bounds.minLat)) * (H - 2 * PAD);
  return { x, y };
}
function unproject(x, y) {
  const lng = bounds.minLng + ((x - PAD) / (W - 2 * PAD)) * (bounds.maxLng - bounds.minLng);
  const lat = bounds.maxLat - ((y - PAD) / (H - 2 * PAD)) * (bounds.maxLat - bounds.minLat);
  return { lat, lng };
}
const STATUS_COLOR = { monitoring: '#16a34a', alerting: '#f59e0b', dispatched: '#ef4444', offline: '#64748b' };

function renderMap() {
  const svg = document.getElementById('map');
  if (!svg || state.drones.length === 0) return;
  computeBounds();
  let s = '';
  // grid
  for (let gx = PAD; gx <= W - PAD; gx += (W - 2 * PAD) / 8) s += `<line x1="${gx}" y1="${PAD}" x2="${gx}" y2="${H - PAD}" stroke="#12283c" stroke-width="1"/>`;
  for (let gy = PAD; gy <= H - PAD; gy += (H - 2 * PAD) / 6) s += `<line x1="${PAD}" y1="${gy}" x2="${W - PAD}" y2="${gy}" stroke="#12283c" stroke-width="1"/>`;
  s += `<rect x="${PAD}" y="${PAD}" width="${W - 2 * PAD}" height="${H - 2 * PAD}" fill="none" stroke="#274b6e" stroke-width="1.5" rx="10"/>`;

  // incident markers (pending alerts + active dispatches)
  for (const a of state.alerts.filter((x) => x.status === 'pending_review' && typeof x.lat === 'number')) {
    const p = project(a.lat, a.lng);
    s += `<circle cx="${p.x}" cy="${p.y}" r="16" fill="#e0842b22" stroke="#e0842b" stroke-width="1.5"><animate attributeName="r" values="12;22;12" dur="1.8s" repeatCount="indefinite"/></circle>
          <text x="${p.x}" y="${p.y + 5}" text-anchor="middle" font-size="15">${incidentMeta(a.incidentType).icon}</text>`;
  }
  for (const d of state.dispatches.filter((x) => x.status === 'active')) {
    const p = project(d.lat, d.lng);
    s += `<circle cx="${p.x}" cy="${p.y}" r="26" fill="none" stroke="#ef4444" stroke-dasharray="5 4" stroke-width="2"><animate attributeName="r" values="20;34;20" dur="2s" repeatCount="indefinite"/></circle>
          <text x="${p.x}" y="${p.y + 6}" text-anchor="middle" font-size="17">🎯</text>`;
  }

  // pending target from map click
  if (state.pendingTarget) {
    const p = project(state.pendingTarget.lat, state.pendingTarget.lng);
    s += `<circle cx="${p.x}" cy="${p.y}" r="10" fill="#e0842b" stroke="#fff" stroke-width="2"/><text x="${p.x}" y="${p.y - 14}" text-anchor="middle" fill="#e0842b" font-size="12" font-weight="700">target</text>`;
  }

  // drones
  for (const d of state.drones) {
    const p = project(d.lat, d.lng);
    const col = STATUS_COLOR[d.status] || '#64748b';
    const ring = d.connected ? `<circle cx="${p.x}" cy="${p.y}" r="14" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.5"><animate attributeName="r" values="11;18;11" dur="2.4s" repeatCount="indefinite"/></circle>` : '';
    s += `${ring}<circle cx="${p.x}" cy="${p.y}" r="8" fill="${col}" stroke="#0d1a27" stroke-width="2"/>
          <text x="${p.x}" y="${p.y - 12}" text-anchor="middle" fill="#9db6cf" font-size="11">🚁 ${esc(d.name.replace('Drone ', 'D'))}</text>`;
  }
  svg.innerHTML = s;

  svg.onclick = (e) => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
    const geo = unproject(loc.x, loc.y);
    state.pendingTarget = geo;
    document.getElementById('d_lat').value = geo.lat.toFixed(5);
    document.getElementById('d_lng').value = geo.lng.toFixed(5);
    renderMap();
    // jump to dispatch tab for convenience
    document.querySelector('.tab[data-tab="dispatch"]').click();
  };
}

// ---------- drone fleet list + on-demand live view ----------
function droneRow(d) {
  const col = STATUS_COLOR[d.status] || '#64748b';
  return `<div class="card" style="padding:0">
    <div class="body" style="gap:6px; padding:12px 14px">
      <div class="row" style="justify-content:space-between">
        <h3 style="font-size:15px">🚁 ${esc(d.name)}</h3>
        <span class="chip" style="border-color:${col}; color:${col}">${esc(d.status)}</span>
      </div>
      <div class="meta">${esc(d.sector)}</div>
      <div class="meta">${d.connected ? '🟢 online' : '⚪ offline'} · 🔋 ${d.battery}%${d.liveView ? ' · 📹 viewing' : ''}</div>
      <div class="actions">
        <button class="btn sm ${d.connected ? 'primary' : ''}" data-live="${d.id}" ${d.connected ? '' : 'disabled'}>📹 Live view</button>
      </div>
    </div>
  </div>`;
}
function renderDroneList() {
  const wrap = document.getElementById('droneList');
  if (!wrap) return;
  wrap.innerHTML = state.drones.map(droneRow).join('');
  wrap.querySelectorAll('[data-live]').forEach((b) => (b.onclick = () => openLive(b.dataset.live)));
}

function setupLiveModal() {
  document.getElementById('liveClose').onclick = closeLive;
  document.getElementById('liveBack').onclick = (e) => { if (e.target.id === 'liveBack') closeLive(); };
}
async function openLive(id) {
  const d = state.drones.find((x) => x.id === id);
  state.liveDroneId = id;
  document.getElementById('liveTitle').textContent = `📹 Live camera — ${d ? d.name : id}`;
  const img = document.getElementById('liveImg');
  img.style.display = 'none';
  img.removeAttribute('src');
  const wait = document.getElementById('liveWait');
  wait.style.display = '';
  wait.textContent = "Waiting for the drone's live feed… (its camera must be on)";
  document.getElementById('liveMeta').textContent = '';
  document.getElementById('liveBack').classList.add('open');
  try {
    await api(`/api/drones/${id}/live/start`, { method: 'POST' });
  } catch (e) {
    wait.textContent = 'Could not start live view: ' + e.message;
  }
}
async function closeLive() {
  const id = state.liveDroneId;
  document.getElementById('liveBack').classList.remove('open');
  state.liveDroneId = null;
  if (id) { try { await api(`/api/drones/${id}/live/stop`, { method: 'POST' }); } catch (e) {} }
}
function onLiveFrame({ droneId, image, at }) {
  if (droneId !== state.liveDroneId) return;
  const img = document.getElementById('liveImg');
  img.src = image;
  img.style.display = 'block';
  document.getElementById('liveWait').style.display = 'none';
  document.getElementById('liveMeta').textContent = 'Live · updated ' + fmtTime(at);
}

// ---------- modal ----------
let modalOnOk = null;
function setupModal() {
  document.getElementById('modalCancel').onclick = closeModal;
  document.getElementById('modalBack').onclick = (e) => { if (e.target.id === 'modalBack') closeModal(); };
  document.getElementById('modalOk').onclick = async () => {
    const note = document.getElementById('modalNote').value;
    const cb = modalOnOk; closeModal();
    if (cb) { try { await cb(note); } catch (e) { alert(e.message); } }
  };
}
function openModal({ title, desc, okLabel, onOk }) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalDesc').textContent = desc;
  document.getElementById('modalNote').value = '';
  document.getElementById('modalOk').textContent = okLabel || 'Confirm';
  modalOnOk = onOk;
  document.getElementById('modalBack').classList.add('open');
}
function closeModal() { document.getElementById('modalBack').classList.remove('open'); modalOnOk = null; }

// ---------- clear captured images (secret-key protected) ----------
function setupClearModal() {
  const back = document.getElementById('clearBack');
  document.getElementById('clearImgBtn').onclick = () => {
    document.getElementById('clearKey').value = '';
    document.getElementById('clearMsg').textContent = '';
    back.classList.add('open');
    document.getElementById('clearKey').focus();
  };
  document.getElementById('clearCancel').onclick = () => back.classList.remove('open');
  back.onclick = (e) => { if (e.target.id === 'clearBack') back.classList.remove('open'); };
  document.getElementById('clearDelete').onclick = () => clearImages('delete');
  document.getElementById('clearArchive').onclick = () => clearImages('archive');
}

async function clearImages(mode) {
  const secretKey = document.getElementById('clearKey').value;
  const msg = document.getElementById('clearMsg');
  if (!secretKey) { msg.style.color = '#f6b45f'; msg.textContent = 'Enter the authorization key.'; return; }
  msg.style.color = ''; msg.textContent = 'Working…';
  try {
    const res = await api('/api/admin/clear-images', { method: 'POST', body: { secretKey, mode } });
    msg.style.color = '#4be3d6';
    msg.textContent = '✅ ' + res.message;
    refreshAlerts();
    refreshDispatches();
    setTimeout(() => document.getElementById('clearBack').classList.remove('open'), 1800);
  } catch (e) {
    msg.style.color = '#ff6b6b';
    msg.textContent = '❌ ' + e.message;
  }
}

// ---------- toast + beep ----------
function toast(a) {
  const m = incidentMeta(a.incidentType);
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="th">${m.icon} ${esc(a.title || m.label)}</div><div class="tb">🚁 ${esc(a.sector || '')} — ${esc((a.interpretation || '').slice(0, 90))}</div>`;
  el.onclick = () => el.remove();
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 7000);
}
let actx;
function beep() {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    o.type = 'sine'; o.frequency.value = 880; g.gain.value = 0.05;
    o.start(); o.stop(actx.currentTime + 0.15);
  } catch (e) {}
}
