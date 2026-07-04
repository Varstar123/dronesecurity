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
  socket.on('dispatch:arrived', (a) => {
    toast({ incidentType: 'normal', title: `🚁 ${a.droneName} reached the location`, sector: 'Dispatch', interpretation: 'Drone in position — live camera available for monitoring.' });
    beep();
    refreshDispatches();
  });
  socket.on('dispatch:resolved', () => { refreshDispatches(); refreshDrones(); });
  socket.on('mainforce:new', () => refreshMF());
  socket.on('live:frame', onLiveFrame);
  socket.on('refresh', () => { refreshDrones(); refreshAlerts(); refreshDispatches(); refreshMF(); });
}

// ---------- data refresh ----------
async function refreshDrones() { state.drones = await api('/api/drones'); renderMap(); renderDroneList(); renderDispatches(); }
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
      if (t.dataset.tab === 'map') setTimeout(renderMap, 80); // let the panel size before Leaflet inits
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
// Accept coordinates as plain decimals OR with degree symbols + N/S/E/W,
// e.g. "11.2545° N", "-11.2545", "75.7800 E".
function parseCoord(token) {
  const m = String(token).trim().match(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?/);
  if (!m) return NaN;
  let v = parseFloat(m[1]);
  const dir = (m[2] || '').toUpperCase();
  if (dir === 'S' || dir === 'W') v = -Math.abs(v);
  return v;
}
// Parse a full pair like "11.2545° N 75.7800° E" or "11.2545, 75.7800".
function parseCoordPair(str) {
  const matches = [...String(str).matchAll(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?/g)];
  if (matches.length < 2) return null;
  const nums = matches.slice(0, 2).map((m) => {
    let v = parseFloat(m[1]);
    const dir = (m[2] || '').toUpperCase();
    if (dir === 'S' || dir === 'W') v = -Math.abs(v);
    return { v, dir };
  });
  let lat, lng;
  for (const n of nums) {
    if (n.dir === 'N' || n.dir === 'S') lat = n.v;
    else if (n.dir === 'E' || n.dir === 'W') lng = n.v;
  }
  if (lat === undefined || lng === undefined) {
    lat = nums[0].v;
    lng = nums[1].v;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

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

  // Paste a full coordinate string (e.g. "11.2545° N 75.7800° E").
  const coordsInput = document.getElementById('d_coords');
  if (coordsInput)
    coordsInput.oninput = () => {
      const p = parseCoordPair(coordsInput.value);
      if (!p) return;
      document.getElementById('d_lat').value = p.lat.toFixed(5);
      document.getElementById('d_lng').value = p.lng.toFixed(5);
      state.pendingTarget = { lat: p.lat, lng: p.lng };
      renderMap();
    };

  document.getElementById('d_send').onclick = async () => {
    const lat = parseCoord(document.getElementById('d_lat').value);
    const lng = parseCoord(document.getElementById('d_lng').value);
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

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function dispatchCard(d) {
  const active = d.status === 'active';
  const latestByDrone = {};
  for (const f of d.frames) latestByDrone[f.droneId] = f;
  const arrivedIds = new Set((d.arrived || []).map((a) => a.droneId));
  const liveById = {};
  state.drones.forEach((x) => (liveById[x.id] = x));
  const droneRows = d.assignedDrones
    .map((a) => {
      const arrived = arrivedIds.has(a.id) || a.arrived;
      const live = liveById[a.id];
      let status;
      if (arrived) status = '✅ reached location';
      else if (active && live) status = `🛰️ en route · ${haversineKm(live, { lat: d.lat, lng: d.lng }).toFixed(2)} km away`;
      else status = `${a.distanceKm} km away`;
      const style = arrived ? ' style="border-color:#16a34a; color:#7cffb0"' : '';
      const cam = arrived && active ? `<button class="btn sm primary" data-livecam="${a.id}">📹 Access live camera</button>` : '';
      return `<span class="chip"${style}>🚁 ${esc(a.name)} · ${status}</span>${cam}`;
    })
    .join('');
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
    <div class="row" style="margin-top:8px; gap:6px; align-items:center">${droneRows}</div>
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
  wrap.querySelectorAll('[data-livecam]').forEach((b) => (b.onclick = () => openLive(b.dataset.livecam)));

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

// ---------- map (Leaflet + real map tiles) ----------
const STATUS_COLOR = { monitoring: '#16a34a', alerting: '#f59e0b', dispatched: '#ef4444', offline: '#64748b' };

let lmap = null;
let mapMarkers = null;

function initMap() {
  const c = CONFIG.cityCenter;
  lmap = L.map('map', { zoomControl: true, attributionControl: true }).setView([c.lat, c.lng], 14);
  // Dark map tiles (free, no API key) to match the control-center theme.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 20,
    attribution: '© OpenStreetMap · © CARTO'
  }).addTo(lmap);
  mapMarkers = L.layerGroup().addTo(lmap);
  lmap.on('click', (e) => {
    state.pendingTarget = { lat: e.latlng.lat, lng: e.latlng.lng };
    document.getElementById('d_lat').value = e.latlng.lat.toFixed(5);
    document.getElementById('d_lng').value = e.latlng.lng.toFixed(5);
    renderMap();
    document.querySelector('.tab[data-tab="dispatch"]').click();
  });
}

function emojiIcon(txt, size) {
  return L.divIcon({
    className: 'emoji-pin',
    html: `<div style="font-size:${size}px;line-height:1;text-shadow:0 1px 3px #000">${txt}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}
function droneIcon(d) {
  const eff = d.connected ? d.status : 'offline';
  const col = STATUS_COLOR[eff] || '#64748b';
  const ring = d.connected ? `box-shadow:0 0 0 4px ${col}55;` : '';
  return L.divIcon({
    className: 'drone-pin',
    html: `<div style="text-align:center">
        <div style="font-size:11px;font-weight:600;color:#e7eef6;text-shadow:0 1px 3px #000;white-space:nowrap">🚁 ${esc(d.name.replace('Drone ', 'D'))}</div>
        <div style="margin:1px auto 0;width:15px;height:15px;border-radius:50%;background:${col};border:2px solid #0d1a27;${ring}"></div>
      </div>`,
    iconSize: [70, 32],
    iconAnchor: [35, 24]
  });
}

function renderMap() {
  if (!document.getElementById('map') || !window.L) return;
  const visible = document.getElementById('panel-map').classList.contains('active');
  if (!lmap) {
    if (!visible) return; // initialise only once the map tab is opened (needs a sized container)
    initMap();
  }
  lmap.invalidateSize();
  mapMarkers.clearLayers();

  // incidents (pending alerts)
  for (const a of state.alerts.filter((x) => x.status === 'pending_review' && typeof x.lat === 'number')) {
    L.marker([a.lat, a.lng], { icon: emojiIcon(incidentMeta(a.incidentType).icon, 24) })
      .bindTooltip(`${incidentMeta(a.incidentType).label} — 🚁 ${esc(a.droneName)}`)
      .addTo(mapMarkers);
  }
  // active dispatch targets + 20 m arrival radius
  for (const d of state.dispatches.filter((x) => x.status === 'active')) {
    L.circle([d.lat, d.lng], { radius: 20, color: '#ef4444', weight: 1.5, fillOpacity: 0.12, dashArray: '4 4' }).addTo(mapMarkers);
    L.marker([d.lat, d.lng], { icon: emojiIcon('🎯', 24) }).bindTooltip(`Dispatch: ${esc(d.address || 'target')}`).addTo(mapMarkers);
  }
  // pending target from a map click
  if (state.pendingTarget) {
    L.marker([state.pendingTarget.lat, state.pendingTarget.lng], { icon: emojiIcon('📍', 26) }).bindTooltip('Dispatch target').addTo(mapMarkers);
  }
  // drones
  for (const d of state.drones) {
    if (typeof d.lat !== 'number') continue;
    L.marker([d.lat, d.lng], { icon: droneIcon(d) })
      .bindTooltip(`🚁 ${esc(d.name)} · ${esc(d.status)}${d.connected ? ' · online' : ''} · ${esc(d.sector)}`)
      .addTo(mapMarkers);
  }
}

// ---------- drone fleet list + on-demand live view ----------
function droneRow(d) {
  const eff = d.connected ? d.status : 'offline';
  const col = STATUS_COLOR[eff] || '#64748b';
  return `<div class="card" style="padding:0">
    <div class="body" style="gap:6px; padding:12px 14px">
      <div class="row" style="justify-content:space-between">
        <h3 style="font-size:15px">🚁 ${esc(d.name)}</h3>
        <span class="chip" style="border-color:${col}; color:${col}">${esc(eff)}</span>
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
