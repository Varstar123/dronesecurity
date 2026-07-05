import { api, esc, timeAgo, fmtTime, loadConfig, CONFIG, incidentMeta, SEV_CLASS, icon, incidentIcon, refreshIcons, initThemePicker } from '/js/common.js';
import { attachAsciiRipple } from '/js/ascii-ripple.js';

const socket = io();
const state = { drones: [], alerts: [], dispatches: [], mf: [], pendingTarget: null, liveDroneId: null };

// ---------- boot ----------
init();
async function init() {
  initThemePicker('themePicker');
  setupFlagWave();
  await loadConfig();
  const badge = document.getElementById('aiBadge');
  badge.textContent = `AI: ${CONFIG.aiLabel || 'Standby'}`;
  badge.className = 'badge ' + (CONFIG.aiMode === 'mock' ? 'mock' : 'live');

  const sel = document.getElementById('d_type');
  sel.innerHTML = Object.entries(CONFIG.incidentTypes)
    .filter(([k]) => k !== 'normal')
    .map(([k, v]) => `<option value="${k}" ${k === 'suspicious_activity' ? 'selected' : ''}>${esc(v.label)}</option>`)
    .join('');

  setupTabs();
  setupDispatchForm();
  setupModal();
  setupLiveModal();
  setupClearModal();
  document.getElementById('resetBtn').onclick = async () => {
    if (confirm('Clear all alerts, dispatches and logs? (drones are kept)')) await api('/api/admin/reset', { method: 'POST' });
  };
  document.getElementById('fitMapBtn').onclick = fitMap;
  document.getElementById('clearAlertsBtn').onclick = async () => {
    if (confirm('Clear all reviewed alerts from the history?')) await api('/api/alerts/clear-reviewed', { method: 'POST' });
  };
  document.getElementById('pinUse').onclick = () => {
    hidePinConfirm();
    document.querySelector('.tab[data-tab="dispatch"]').click();
  };
  document.getElementById('pinCancel').onclick = () => {
    state.pendingTarget = null;
    renderMap();
    hidePinConfirm();
  };

  wireSocket();
  socket.emit('police:join');
  await Promise.all([refreshDrones(), refreshAlerts(), refreshDispatches(), refreshMF()]);
  setStats(await api('/api/stats'));
  refreshIcons();
  setInterval(() => { renderAlerts(); renderDispatches(); renderMF(); }, 30000); // refresh "x ago"
}

function wireSocket() {
  socket.on('stats', setStats);
  // Update just the one drone from the event payload and coalesce re-renders, instead
  // of refetching the whole fleet on every position ping (which scales with drones²).
  socket.on('drone:status', (drone) => { if (drone && drone.id) upsertDrone(drone); else refreshDrones(); });
  socket.on('alert:new', (a) => { refreshAlerts(); toast(a); beep(); });
  socket.on('alert:updated', () => refreshAlerts());
  socket.on('dispatch:new', (d) => { refreshDispatches(); toast({ incidentType: d.incidentType, title: 'Drones dispatched', interpretation: `${d.assignedDrones.length} drones surrounding ${d.address || 'target'}`, sector: d.address }); });
  socket.on('dispatch:frame', onFrame);
  socket.on('dispatch:updated', () => refreshDispatches());
  socket.on('dispatch:arrived', (a) => {
    toast({ incidentType: 'normal', title: `${a.droneName} reached the location`, sector: 'Dispatch', interpretation: 'Drone in position — live camera available for monitoring.' });
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

// Merge a single drone update from a socket event into local state (no network),
// then re-render on a short debounce so a burst of position pings costs one paint.
function upsertDrone(drone) {
  const i = state.drones.findIndex((x) => x.id === drone.id);
  if (i >= 0) state.drones[i] = drone; else state.drones.push(drone);
  scheduleDroneRender();
}
let droneRenderTimer = null;
function scheduleDroneRender() {
  if (droneRenderTimer) return;
  droneRenderTimer = setTimeout(() => {
    droneRenderTimer = null;
    renderMap();
    renderDroneList();
    // Only rebuild the dispatch list if one is active — resolved/idle cards use static
    // distances, so skipping avoids a full re-render (+ icon scan) on every position ping.
    if (state.dispatches.some((d) => d.status === 'active')) renderDispatches();
  }, 150);
}
async function refreshAlerts() { state.alerts = await api('/api/alerts'); renderAlerts(); renderMap(); }
async function refreshDispatches() { state.dispatches = await api('/api/dispatches'); renderDispatches(); renderMap(); }
async function refreshMF() { state.mf = await api('/api/mainforce'); renderMF(); }

// A frame now arrives inline ({ dispatchId, droneId, image, ... }). In steady state we
// just swap ONE <img>.src — no list rebuild, no document-wide icon scan (the old jank).
function onFrame(p) {
  if (!p || !p.dispatchId || !p.droneId || !p.image) return;
  const key = p.dispatchId + '__' + p.droneId;
  state.liveFrames = state.liveFrames || {};
  state.liveFrames[key] = p.image; // cache the newest frame so full re-renders keep it
  const sel = 'img[data-feed="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]';
  const img = document.querySelector(sel);
  if (img) { img.src = p.image; return; } // steady state — one cheap swap
  // First frame for this tile (still the "surrounding…" placeholder) → build the card once.
  const d = state.dispatches.find((x) => x.id === p.dispatchId);
  if (d) renderDispatches(); else refreshDispatches();
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

// One-time Indian-flag wave across each stat tile on its FIRST hover (tricolour only).
function setupFlagWave() {
  document.querySelectorAll('.stats .tile').forEach((tile) => {
    if (!tile.querySelector('.flag-sweep')) tile.insertAdjacentHTML('beforeend', '<span class="flag-sweep"></span>');
    let waved = false;
    tile.addEventListener('mouseenter', () => {
      if (waved || document.documentElement.dataset.theme !== 'tricolor') return;
      waved = true;
      tile.classList.add('flag-wave');
      tile.addEventListener('animationend', () => tile.classList.remove('flag-wave'), { once: true });
    });
  });
}

// ---------- tabs ----------
function setupTabs() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('panel-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'map') setTimeout(() => { renderMap(); fitMap(); }, 80); // size + frame all drones
    };
  });
}

// ---------- alerts (compact card, full detail on click) ----------
function alertCard(a, reviewed) {
  const m = incidentMeta(a.incidentType);
  const conf = Math.round((a.confidence || 0) * 100);
  const sev = `<span class="sev ${SEV_CLASS[a.severity] || 'sev-medium'}">${esc(a.severity)}</span>`;
  const sourceLabel = a.source && a.source.startsWith('claude') ? 'Claude Vision' : a.source && a.source.startsWith('groq') ? 'Groq Vision' : 'AI Vision';

  const actions = reviewed
    ? `<div class="ac-actions"><span class="chip">${a.status === 'escalated' ? icon('megaphone') + ' Escalated to main force' : icon('check') + ' Dismissed'}</span>${a.reviewNote ? `<span class="meta">“${esc(a.reviewNote)}” — ${esc(a.reviewedBy || '')}</span>` : ''}</div>`
    : `<div class="ac-actions">
         <button class="btn danger sm" data-esc="${a.id}">${icon('megaphone')} Escalate to Main Force</button>
         <button class="btn primary sm" data-dis="${a.id}">${icon('check')} Situation OK — Resume</button>
       </div>`;

  // Leading thumbnail shown on the collapsed card (image if captured, else the incident icon).
  const thumbSm = a.imageUrl
    ? `<div class="ac-thumb-sm"><img src="${a.imageUrl}" alt="" loading="lazy" /></div>`
    : `<div class="ac-thumb-sm ac-thumb-icon" style="color:${m.color}">${icon(m.lucide)}</div>`;
  const fullImg = a.imageUrl ? `<img class="ac-thumb" src="${a.imageUrl}" alt="captured frame" />` : '';

  return `<div class="alert-card ${reviewed ? 'reviewed' : ''}">
    <div class="ac-head" data-toggle="${a.id}">
      ${thumbSm}
      <div class="ac-main">
        <div class="ac-title"><span class="ac-ic" style="color:${m.color}">${icon(m.lucide)}</span> ${esc(a.title)} ${sev}</div>
        <div class="ac-sub">${icon('bot')} ${esc(a.droneName)} · ${icon('map-pin')} ${esc(a.sector)} · ${icon('clock')} ${timeAgo(a.timestamp)}</div>
        <div class="ac-snippet">${esc(a.interpretation)}</div>
      </div>
      <span class="ac-chevron">${icon('chevron-down')}</span>
    </div>
    <div class="ac-details">
      ${fullImg}
      <div class="interp" style="margin-top:${a.imageUrl ? '12' : '0'}px">“${esc(a.interpretation)}”</div>
      <div class="meta" style="margin-top:8px">${icon('lightbulb')} Suggested: ${esc(a.recommendedAction)}</div>
      <div class="row" style="margin-top:8px"><span class="meta" style="width:78px">Confidence</span><div class="conf-bar" style="flex:1"><span style="width:${conf}%"></span></div><span class="meta">${conf}%</span></div>
      <div class="meta" style="margin-top:6px">${icon('crosshair')} ${typeof a.lat === 'number' ? a.lat.toFixed(5) + ', ' + a.lng.toFixed(5) : '—'} · ${icon('cpu')} ${sourceLabel}</div>
      ${actions}
    </div>
  </div>`;
}

function renderAlerts() {
  const pending = state.alerts.filter((a) => a.status === 'pending_review');
  const reviewed = state.alerts.filter((a) => a.status !== 'pending_review');
  const p = document.getElementById('alertsPending');
  const h = document.getElementById('alertsHistory');
  p.innerHTML = pending.length ? pending.map((a) => alertCard(a, false)).join('') : `<div class="empty ripple-empty">No pending alerts. Drones are monitoring…</div>`;
  h.innerHTML = reviewed.length ? reviewed.map((a) => alertCard(a, true)).join('') : `<div class="empty ripple-empty">Nothing reviewed yet.</div>`;
  // Give the two empty-state messages the glitch-ripple effect (self-running).
  for (const wrap of [p, h]) {
    const empty = wrap.querySelector('.ripple-empty');
    if (empty) attachAsciiRipple(empty, { auto: true });
  }
  const cab = document.getElementById('clearAlertsBtn');
  if (cab) cab.style.display = reviewed.length ? '' : 'none';
  for (const wrap of [p, h])
    wrap.querySelectorAll('[data-toggle]').forEach((head) => (head.onclick = () => head.closest('.alert-card').classList.toggle('open')));
  p.querySelectorAll('[data-esc]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); reviewAlert(b.dataset.esc, 'escalate'); }));
  p.querySelectorAll('[data-dis]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); reviewAlert(b.dataset.dis, 'dismiss'); }));
  refreshIcons();
}

function reviewAlert(id, kind) {
  const a = state.alerts.find((x) => x.id === id);
  if (!a) return;
  const escalate = kind === 'escalate';
  openModal({
    title: escalate ? 'Escalate to Main Force' : 'Dismiss — Resume Monitoring',
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

// Pull coordinates out of a map/location URL (Google Maps, OSM, Apple, etc.).
const MAP_COORD_PATTERNS = [
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,
  /[?&]q=loc:(-?\d+\.\d+),(-?\d+\.\d+)/,
  /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
  /[?&](?:ll|sll|destination|center)=(-?\d+\.\d+),(-?\d+\.\d+)/,
  /[?&]mlat=(-?\d+\.\d+)&mlon=(-?\d+\.\d+)/,
  /#map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/,
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  /[/=](-?\d+\.\d+),(-?\d+\.\d+)/
];
function coordsFromUrl(s) {
  for (const re of MAP_COORD_PATTERNS) {
    const m = String(s).match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}
// A link → URL patterns only; otherwise plain coordinates.
function extractCoords(str) {
  const s = String(str).trim();
  return /^https?:\/\//i.test(s) ? coordsFromUrl(s) : parseCoordPair(s);
}

const DISPATCH_PRESETS = [
  { icon: 'gem', label: 'Jewellery robbery', type: 'theft_robbery', desc: 'Armed robbery reported at a jewellery shop.' },
  { icon: 'landmark', label: 'Bank robbery', type: 'theft_robbery', desc: 'Robbery in progress at a bank.' },
  { icon: 'crosshair', label: 'Armed person', type: 'weapon_threat', desc: 'Armed person threatening people at the location.' },
  { icon: 'user-x', label: 'Kidnapping', type: 'suspicious_activity', desc: 'Possible abduction / kidnapping reported.' },
  { icon: 'bomb', label: 'Bomb threat', type: 'abandoned_object', desc: 'Suspicious package / bomb threat reported.' },
  { icon: 'swords', label: 'Violence', type: 'violence_assault', desc: 'Violent assault / fight reported.' },
  { icon: 'flame', label: 'Fire', type: 'building_fire', desc: 'Building fire reported at the location.' }
];

function setupDispatchForm() {
  const clearDisp = document.getElementById('clearDispBtn');
  if (clearDisp)
    clearDisp.onclick = async () => {
      if (confirm('Clear all resolved dispatches from the list?')) await api('/api/dispatches/clear-resolved', { method: 'POST' });
    };

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
    (p, i) => `<button class="btn sm" data-preset="${i}">${icon(p.icon)} ${esc(p.label)}</button>`
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

  // Paste coordinates ("11.2545° N 75.7800° E") OR a shared map/location link.
  const coordsInput = document.getElementById('d_coords');
  const coordStatus = document.getElementById('coordStatus');
  const setCoordStatus = (msg, color) => {
    if (coordStatus) { coordStatus.innerHTML = msg; coordStatus.style.color = color || 'var(--muted)'; refreshIcons(); }
  };
  const fillCoords = (p) => {
    document.getElementById('d_lat').value = p.lat.toFixed(5);
    document.getElementById('d_lng').value = p.lng.toFixed(5);
    state.pendingTarget = { lat: p.lat, lng: p.lng };
    renderMap();
    setCoordStatus(`${icon('map-pin')} ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, '#4be3d6');
  };
  const resolveLink = async () => {
    const v = coordsInput.value.trim();
    if (!v) return setCoordStatus('');
    const local = extractCoords(v);
    if (local) return fillCoords(local);
    if (!/^https?:\/\//i.test(v)) return; // still typing plain coordinates
    setCoordStatus('resolving link…');
    try {
      const r = await api('/api/resolve-location', { method: 'POST', body: { url: v } });
      if (r && Number.isFinite(r.lat)) fillCoords(r);
      else setCoordStatus("couldn't read coordinates from that link", '#ff6b6b');
    } catch (e) {
      setCoordStatus("couldn't open that link: " + e.message, '#ff6b6b');
    }
  };
  if (coordsInput) {
    coordsInput.oninput = () => { const p = extractCoords(coordsInput.value); if (p) fillCoords(p); };
    coordsInput.addEventListener('paste', () => setTimeout(resolveLink, 60));
    coordsInput.addEventListener('change', resolveLink); // blur / Enter
  }

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
      hidePinConfirm();
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
      if (arrived) status = `${icon('circle-check')} reached location`;
      else if (active && live) status = `${icon('navigation')} en route · ${haversineKm(live, { lat: d.lat, lng: d.lng }).toFixed(2)} km away`;
      else status = `${a.distanceKm} km away`;
      const style = arrived ? ' style="border-color:#16a34a; color:#7cffb0"' : '';
      // Police can pull the live camera from any online assigned drone — even while it
      // is still en route to the target — so they can watch the approach, not just after arrival.
      const online = !!(live && live.connected);
      // Live battery of the assigned drone (only meaningful while it's online).
      const bat = online && typeof live.battery === 'number' ? live.battery : null;
      const batIcon = bat == null ? '' : bat > 60 ? 'battery-full' : bat > 25 ? 'battery-medium' : bat > 0 ? 'battery-low' : 'battery';
      const batCol = bat == null ? '' : bat > 25 ? '#7cffb0' : bat > 10 ? '#f59e0b' : '#ef4444';
      const batTxt = bat == null ? '' : ` · <span style="color:${batCol}">${icon(batIcon)} ${bat}%</span>`;
      const camLabel = arrived ? 'Access live camera' : 'Live camera (en route)';
      const cam = active && online ? `<button class="btn sm primary" data-livecam="${a.id}">${icon('video')} ${camLabel}</button>` : '';
      return `<span class="chip"${style}>${icon('bot')} ${esc(a.name)} · ${status}${batTxt}</span>${cam}`;
    })
    .join('');
  const tiles = d.assignedDrones
    .map((ad) => {
      const key = d.id + '__' + ad.id;
      // Prefer the newest live inline frame (cached by onFrame); fall back to the last
      // archived thumbnail URL; else the "surrounding…" placeholder.
      const cached = state.liveFrames && state.liveFrames[key];
      const f = latestByDrone[ad.id];
      const src = cached || (f && f.url);
      if (src) {
        return `<div class="frame-tile"><img data-feed="${key}" src="${src}" alt="live" /><span class="live">● LIVE</span><span class="lbl">${esc(ad.name)}</span></div>`;
      }
      return `<div class="frame-tile sim-tile"><div class="scan"></div>${icon('bot')}<div>${esc(ad.name)}</div><div>surrounding…</div></div>`;
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
      <h3 style="margin:0"><span style="color:${m.color}">${icon(m.lucide)}</span> ${esc(m.label)}</h3>
      <span class="meta">${esc(d.address || d.lat.toFixed(4) + ', ' + d.lng.toFixed(4))} · ${timeAgo(d.timestamp)}</span>
    </div>
    ${d.description ? `<div class="interp" style="margin-top:6px">“${esc(d.description)}”</div>` : ''}
    <div class="row" style="margin-top:8px; gap:8px; align-items:center; display:flex; flex-wrap:wrap">${droneRows}</div>
    <div class="footage">${tiles}</div>
    ${updates}
    ${active ? `<div style="margin-top:14px">
        <input id="conv_${d.id}" placeholder="Convey info to main force (e.g. 2 suspects, north exit)" style="width:100%" />
        <div style="display:flex; gap:8px; margin-top:10px">
          <button class="btn warn" data-convey="${d.id}">${icon('send')} Convey</button>
          <button class="btn primary" data-resolve="${d.id}">${icon('circle-check')} Resolve</button>
        </div>
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
  wrap.innerHTML = list.length ? list.map(dispatchCard).join('') : `<div class="empty ripple-empty">No dispatches yet. Enter a location to send drones.</div>`;
  const dispEmpty = wrap.querySelector('.ripple-empty');
  if (dispEmpty) attachAsciiRipple(dispEmpty, { auto: true });
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
  // Show the "clear resolved" button only when there is resolved history.
  const clearBtn = document.getElementById('clearDispBtn');
  if (clearBtn) clearBtn.style.display = state.dispatches.some((d) => d.status !== 'active') ? '' : 'none';
  refreshIcons();
}

// ---------- main force ----------
function renderMF() {
  const wrap = document.getElementById('mfList');
  wrap.innerHTML = state.mf.length
    ? state.mf.map((r) => {
        const m = incidentMeta(r.incidentType);
        return `<div class="log-item">
          <div class="t">${new Date(r.timestamp).toLocaleString()} · ${r.sourceType === 'alert' ? 'Escalation' : 'Field update'} · by ${esc(r.officer)}</div>
          <div style="margin-top:4px"><b><span style="color:${m.color}">${icon(m.lucide)}</span> ${esc(r.title)}</b> — ${esc(r.location)} · ${icon('bot')} ${esc(r.droneName || '')}</div>
          <div class="interp" style="margin-top:4px">“${esc(r.conveyed)}”</div>
        </div>`;
      }).join('')
    : `<div class="empty ripple-empty">Nothing has been sent to the main force yet.</div>`;
  const mfEmpty = wrap.querySelector('.ripple-empty');
  if (mfEmpty) attachAsciiRipple(mfEmpty, { auto: true });
  refreshIcons();
}

// ---------- map (Leaflet + real map tiles) ----------
const STATUS_COLOR = { monitoring: '#16a34a', alerting: '#f59e0b', dispatched: '#ef4444', offline: '#64748b' };

let lmap = null;
let mapMarkers = null;
let mapFitted = false;

// Frame the map to include every drone (wherever their phone GPS puts them),
// plus any active dispatches / pending incidents.
function fitMap() {
  if (!lmap) return;
  const pts = [];
  for (const d of state.drones) if (d.connected && typeof d.lat === 'number') pts.push([d.lat, d.lng]);
  for (const d of state.dispatches) if (d.status === 'active') pts.push([d.lat, d.lng]);
  for (const a of state.alerts) if (a.status === 'pending_review' && typeof a.lat === 'number') pts.push([a.lat, a.lng]);
  if (!pts.length) return;
  if (pts.length === 1) lmap.setView(pts[0], 14);
  else lmap.fitBounds(pts, { padding: [45, 45], maxZoom: 15 });
}

function showPinConfirm() {
  const el = document.getElementById('pinConfirm');
  const t = state.pendingTarget;
  if (!el || !t) return;
  document.getElementById('pinCoords').textContent = `${t.lat.toFixed(5)}, ${t.lng.toFixed(5)}`;
  el.classList.add('show');
  refreshIcons();
}
function hidePinConfirm() {
  const el = document.getElementById('pinConfirm');
  if (el) el.classList.remove('show');
}

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
    showPinConfirm(); // ask to confirm instead of jumping to the dispatch tab
  });
}

function lucidePin(name, color, size) {
  return L.divIcon({
    className: 'lucide-pin',
    html: `<div style="color:${color};font-size:${size}px;line-height:1;filter:drop-shadow(0 1px 2px #000)">${icon(name)}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}
// A standard filled teardrop map pin (its tip sits on the exact coordinate).
function solidPin(color, size) {
  const h = Math.round(size * 1.32);
  return L.divIcon({
    className: 'solid-pin',
    html: `<svg width="${size}" height="${h}" viewBox="0 0 24 32" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.55))"><path d="M12 0C5.37 0 0 5.37 0 12c0 8.5 12 20 12 20s12-11.5 12-20C24 5.37 18.63 0 12 0z" fill="${color}"/><circle cx="12" cy="12" r="4.6" fill="#0d1a27"/></svg>`,
    iconSize: [size, h],
    iconAnchor: [size / 2, h]
  });
}
function droneIcon(d) {
  const eff = d.connected ? d.status : 'offline';
  const col = STATUS_COLOR[eff] || '#64748b';
  const ring = d.connected ? `box-shadow:0 0 0 4px ${col}55;` : '';
  return L.divIcon({
    className: 'drone-pin',
    html: `<div style="text-align:center">
        <div style="font-size:11px;font-weight:600;color:#e7eef6;text-shadow:0 1px 3px #000;white-space:nowrap">${esc(d.name.replace('Drone ', 'D'))}</div>
        <div style="margin:1px auto 0;width:15px;height:15px;border-radius:50%;background:${col};border:2px solid #0d1a27;${ring}"></div>
      </div>`,
    iconSize: [70, 32],
    iconAnchor: [35, 24]
  });
}

function renderMap() {
  renderFleetPanel(); // keep the fleet roster side panel in sync (independent of Leaflet/visibility)
  if (!document.getElementById('map') || !window.L) return;
  const visible = document.getElementById('panel-map').classList.contains('active');
  if (!lmap) {
    if (!visible) return; // initialise only once the map tab is opened (needs a sized container)
    initMap();
  }
  // Hidden map: skip the full marker teardown/rebuild + icon scan. setupTabs re-renders
  // when the Map tab is opened, so nothing goes stale.
  if (!visible) return;
  lmap.invalidateSize();
  mapMarkers.clearLayers();

  // incidents (pending alerts)
  for (const a of state.alerts.filter((x) => x.status === 'pending_review' && typeof x.lat === 'number')) {
    const m = incidentMeta(a.incidentType);
    L.marker([a.lat, a.lng], { icon: lucidePin(m.lucide, m.color, 22) })
      .bindTooltip(`${m.label} — ${esc(a.droneName)}`)
      .addTo(mapMarkers);
  }
  // active dispatch targets + 20 m arrival radius
  for (const d of state.dispatches.filter((x) => x.status === 'active')) {
    L.circle([d.lat, d.lng], { radius: 20, color: '#ef4444', weight: 1.5, fillOpacity: 0.12, dashArray: '4 4' }).addTo(mapMarkers);
    L.marker([d.lat, d.lng], { icon: solidPin('#ef4444', 26) }).bindTooltip(`Dispatch: ${esc(d.address || 'target')}`).addTo(mapMarkers);
  }
  // pending target from a map click
  if (state.pendingTarget) {
    L.marker([state.pendingTarget.lat, state.pendingTarget.lng], { icon: solidPin('#e0842b', 28) }).bindTooltip('Dispatch target').addTo(mapMarkers);
  }
  // drones — only those actually online (a phone is controlling them) show on the map.
  // Offline drones live in the side box instead, and re-appear here when they connect.
  for (const d of state.drones) {
    if (!d.connected || typeof d.lat !== 'number') continue;
    L.marker([d.lat, d.lng], { icon: droneIcon(d) })
      .bindTooltip(`${esc(d.name)} · ${esc(d.status)} · online · ${esc(d.sector)}`)
      .addTo(mapMarkers);
  }
  refreshIcons();
  if (!mapFitted && state.drones.some((d) => d.connected)) { mapFitted = true; fitMap(); } // frame the online fleet
}

// Side panel = the full fleet roster (online + offline). The map only draws the ONLINE
// drones; here you see all of them with live status, online ones listed first.
function renderFleetPanel() {
  const wrap = document.getElementById('offlineBox');
  if (!wrap) return;
  const drones = [...state.drones].sort((a, b) => (b.connected ? 1 : 0) - (a.connected ? 1 : 0) || a.name.localeCompare(b.name));
  const onlineCount = state.drones.filter((d) => d.connected).length;
  const items = drones.map((d) => {
    const on = d.connected;
    const dot = on ? (STATUS_COLOR[d.status] || '#16a34a') : '#64748b';
    const bat = typeof d.battery === 'number' ? d.battery : null;
    const line = on
      ? `<span style="color:#7cffb0">${esc(d.status)}</span>${bat != null ? ' · ' + bat + '%' : ''}${d.liveView ? ' · ' + icon('video') + ' viewing' : ''}`
      : (d.lastSeen ? 'offline · last seen ' + timeAgo(d.lastSeen) : 'offline · not yet connected');
    return `<div class="ob-item${on ? ' on' : ''}">
      <span class="icon3d ${on ? 'i3-teal' : 'i3-slate'} ob-ic">${icon('bot')}</span>
      <div class="ob-id">
        <div class="ob-name">${esc(d.name)} <span class="ob-dot" style="background:${dot}"></span></div>
        <div class="meta">${icon('map-pin')} ${esc(d.sector)}</div>
        <div class="meta ob-seen">${line}</div>
      </div>
    </div>`;
  }).join('');
  wrap.innerHTML =
    `<div class="ob-head">${icon('radar')} Drone fleet <span class="ob-count">${onlineCount}/${state.drones.length}</span></div>` +
    `<div class="ob-sub">Live roster — only online drones are shown on the map.</div>` +
    `<div class="ob-list">${items}</div>`;
  refreshIcons();
}

// ---------- drone fleet list + on-demand live view ----------
function droneRow(d) {
  const eff = d.connected ? d.status : 'offline';
  const col = STATUS_COLOR[eff] || '#64748b';
  const b = typeof d.battery === 'number' ? d.battery : 0;
  const battClass = b > 60 ? '' : b > 25 ? 'mid' : 'low';
  // Icon badge colour mirrors the drone's live state.
  const accent = eff === 'dispatched' ? 'red' : eff === 'alerting' ? 'amber' : d.connected ? 'teal' : 'slate';
  return `<div class="fleet-card">
    <div class="fleet-top">
      <span class="icon3d i3-${accent}">${icon('bot')}</span>
      <div class="fleet-id">
        <div class="fleet-name">${esc(d.name)}</div>
        <div class="meta">${icon('map-pin')} ${esc(d.sector)}</div>
      </div>
      <span class="chip" style="border-color:${col}; color:${col}">${esc(eff)}</span>
    </div>
    <div class="fleet-batt">
      <div class="meta">
        <span><span style="color:${d.connected ? '#16a34a' : '#64748b'}">${icon(d.connected ? 'circle-check' : 'circle')}</span> ${d.connected ? 'online' : 'offline'}${d.liveView ? ' · ' + icon('video') + ' viewing' : ''}</span>
        <span style="font-variant-numeric:tabular-nums">${b}%</span>
      </div>
      <div class="hatch"><span class="bar-fill ${battClass}" style="width:${Math.max(4, Math.min(100, b))}%"></span></div>
    </div>
    <div class="actions">
      <button class="btn sm ${d.connected ? 'primary' : ''}" data-live="${d.id}" ${d.connected ? '' : 'disabled'}>${icon('video')} Live view</button>
    </div>
  </div>`;
}
function renderDroneList() {
  const wrap = document.getElementById('droneList');
  if (!wrap) return;
  wrap.innerHTML = state.drones.map(droneRow).join('');
  wrap.querySelectorAll('[data-live]').forEach((b) => (b.onclick = () => openLive(b.dataset.live)));
  refreshIcons();
}

function setupLiveModal() {
  document.getElementById('liveClose').onclick = closeLive;
  document.getElementById('liveBack').onclick = (e) => { if (e.target.id === 'liveBack') closeLive(); };
}
async function openLive(id) {
  const d = state.drones.find((x) => x.id === id);
  state.liveDroneId = id;
  document.getElementById('liveTitle').textContent = `Live camera — ${d ? d.name : id}`;
  const img = document.getElementById('liveImg');
  img.style.display = 'none';
  img.removeAttribute('src');
  const wait = document.getElementById('liveWait');
  wait.style.display = '';
  wait.textContent = "Waiting for the drone's live feed… (its camera must be on)";
  document.getElementById('liveMeta').textContent = '';
  document.getElementById('liveBack').classList.add('open');
  socket.emit('police:watch', { droneId: id }); // so the server stops the feed if this tab closes
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
  if (id) {
    socket.emit('police:unwatch', { droneId: id });
    try { await api(`/api/drones/${id}/live/stop`, { method: 'POST' }); } catch (e) {}
  }
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
  el.innerHTML = `<div class="th"><span style="color:${m.color}">${icon(m.lucide)}</span> ${esc(a.title || m.label)}</div><div class="tb">${esc(a.sector || '')} — ${esc((a.interpretation || '').slice(0, 90))}</div>`;
  el.onclick = () => el.remove();
  document.getElementById('toasts').appendChild(el);
  refreshIcons();
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
