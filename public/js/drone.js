import { api, esc, loadConfig, CONFIG, incidentMeta, icon, incidentIcon, refreshIcons, initThemePicker } from '/js/common.js';

const socket = io();
const $ = (id) => document.getElementById(id);

// Stable per-device id so the server can tell a reconnect (same phone) apart from
// a real conflict (a different phone grabbing the same drone). Survives reloads.
const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem('droneDeviceId');
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2) + Date.now().toString(36);
      localStorage.setItem('droneDeviceId', id);
    }
    return id;
  } catch {
    return String(Math.random()).slice(2);
  }
})();

const st = {
  droneId: null,
  coords: { lat: CONFIG.cityCenter.lat, lng: CONFIG.cityCenter.lng },
  drones: [],
  stream: null,
  autoTimer: null,
  streamTimer: null,
  streamRunning: false, // dispatch stream loop active
  liveTimer: null, // on-demand live view requested by police
  liveRunning: false, // on-demand live loop active
  dispatch: null, // { dispatchId, address, droneId }
  gpsWatch: null,
  lastLocSent: 0, // throttle for live location updates
  battery: null, // phone battery %, from the Battery Status API
  busy: false,
  awaitingReview: false // an alert was raised and is waiting for police review
};

init();
async function init() {
  initThemePicker('themePicker');
  await loadConfig();

  // Scenario override (only relevant when no live AI provider is configured;
  // a real provider analyses the actual camera image, so hide it then).
  const opts = ['<option value="auto">Auto</option>']
    .concat(Object.entries(CONFIG.incidentTypes).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`));
  $('scenario').innerHTML = opts.join('');
  if (CONFIG.aiMode !== 'mock') $('scenarioBox').style.display = 'none';

  st.drones = await api('/api/drones');
  st.droneId = randomFreeDroneId(); // default to a drone no other device is using
  populateDroneSelect();
  selectDrone(st.droneId);

  $('droneSel').onchange = () => selectDrone($('droneSel').value);
  $('startCam').onclick = startCamera;
  $('scanBtn').onclick = () => scan();
  $('stopCam').onclick = stopCamera;
  $('autoChk').onchange = updateAuto;
  $('interval').onchange = updateAuto;
  $('gpsChk').onchange = toggleGps;

  wireSocket();
  toggleGps(); // start live GPS tracking (checkbox is on by default)
  initBattery();
  refreshIcons();
  // Heartbeat: keep the portal's position, battery and "online" state fresh
  // even when the phone is stationary (watchPosition may go quiet).
  setInterval(() => { if (st.gpsWatch != null) sendLocation(true); }, 5000);
}

// ---------- phone battery (Battery Status API) ----------
function initBattery() {
  if (!navigator.getBattery) {
    $('batteryBadge').style.display = 'none';
    return;
  }
  navigator
    .getBattery()
    .then((bat) => {
      const update = () => {
        st.battery = Math.round(bat.level * 100);
        const badge = $('batteryBadge');
        badge.style.display = '';
        badge.className = 'badge ' + (st.battery > 20 ? 'live' : 'mock');
        badge.textContent = `🔋 ${st.battery}%`;
        sendLocation(true); // push updated battery to the portal
      };
      update();
      bat.addEventListener('levelchange', update);
      bat.addEventListener('chargingchange', update);
    })
    .catch(() => { $('batteryBadge').style.display = 'none'; });
}

function selectDrone(id) {
  st.droneId = id;
  const d = st.drones.find((x) => x.id === id);
  if (d) st.coords = { lat: d.lat, lng: d.lng }; // sector baseline; live GPS overrides
  socket.emit('drone:hello', { droneId: id, deviceId: DEVICE_ID });
  setStatus('mon', d ? `Monitoring · ${d.sector}` : 'Monitoring');
  populateDroneSelect();
}

// Build the drone dropdown, disabling drones already used by another device.
function populateDroneSelect() {
  const sel = $('droneSel');
  sel.innerHTML = st.drones
    .map((d) => {
      const taken = d.connected && d.id !== st.droneId;
      return `<option value="${d.id}" ${taken ? 'disabled' : ''}>${esc(d.name)} — ${esc(d.sector)}${taken ? ' · in use' : ''}</option>`;
    })
    .join('');
  if (st.droneId) sel.value = st.droneId;
}

function randomFreeDroneId() {
  const free = st.drones.filter((d) => !d.connected);
  const pool = free.length ? free : st.drones;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function wireSocket() {
  socket.on('connect', () => { if (st.droneId) socket.emit('drone:hello', { droneId: st.droneId, deviceId: DEVICE_ID }); });
  // Another device took/freed a drone → refresh the dropdown's disabled state.
  socket.on('fleet:changed', async () => {
    try { st.drones = await api('/api/drones'); populateDroneSelect(); } catch (e) {}
  });
  // The drone we picked is already in use → switch to an available one.
  socket.on('drone:taken', ({ available } = {}) => {
    const list = available || [];
    if (!list.length) { alert('All drones are currently in use by other devices.'); return; }
    const pick = list[Math.floor(Math.random() * list.length)];
    alert('That drone is already in use by another device — switching you to an available drone.');
    selectDrone(pick);
  });
  socket.on('drone:command', (cmd) => {
    if (cmd.type === 'dispatch') enterDispatch(cmd);
    else if (cmd.type === 'resume') exitDispatch(cmd.message);
    else if (cmd.type === 'livestream') startLive();
    else if (cmd.type === 'livestream_stop') stopLive();
  });
}

// ---------- camera ----------
async function startCamera() {
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false
    });
  } catch (err) {
    alert('Could not access the camera.\n\n' + err.message +
      '\n\nOn a phone you must open the app over HTTPS (see the https:// link the server prints). Accept the certificate warning, then allow the camera.');
    return;
  }
  const v = $('video');
  v.srcObject = st.stream;
  await v.play().catch(() => {});
  $('camOff').style.display = 'none';
  $('scanBtn').disabled = false;
  $('stopCam').disabled = false;
  setStatus('mon', 'Monitoring — camera live');
  updateAuto();
}

function stopCamera() {
  if (st.autoTimer) clearInterval(st.autoTimer), (st.autoTimer = null);
  st.streamRunning = false;
  if (st.streamTimer) clearTimeout(st.streamTimer), (st.streamTimer = null);
  st.liveRunning = false;
  if (st.liveTimer) clearTimeout(st.liveTimer), (st.liveTimer = null);
  $('liveChip').classList.remove('show');
  const wasDispatch = !!st.dispatch;
  st.dispatch = null;
  st.awaitingReview = false;
  $('dispatchBanner').classList.remove('show');
  $('droneSel').disabled = false;
  if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
  st.stream = null;
  $('video').srcObject = null;
  $('camOff').style.display = 'flex';
  $('verdict').classList.add('hidden'); // clear the stale last-scan verdict
  $('scanBtn').disabled = true;
  $('stopCam').disabled = true;
  $('autoChk').checked = false;
  setStatus('mon', wasDispatch ? 'Camera stopped — dispatch streaming halted' : 'Camera stopped');
}

// measureBrightness is only needed by the auto-scan path (to skip near-black frames);
// the dispatch/live streaming loops throw it away, so they skip the costly getImageData readback.
function captureFrame(measureBrightness = false) {
  const v = $('video');
  if (!v.videoWidth) return null;
  const w = 640;
  const h = Math.round((v.videoHeight / v.videoWidth) * w) || 480;
  const c = $('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0, w, h);
  // Average brightness (for skipping near-black frames on auto-monitor).
  if (measureBrightness) try {
    const d = ctx.getImageData(0, 0, w, h).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 64) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++; }
    st.lastBrightness = sum / n;
  } catch {
    st.lastBrightness = 255; // getImageData blocked — assume a real frame
  }
  return c.toDataURL('image/jpeg', 0.6);
}

// Capture a JPEG as a raw ArrayBuffer (for binary live streaming — no base64 bloat).
// Smaller + lower quality than the analysis frame: a live feed wants low latency, not
// detail, so keep each frame tiny (~10-18 KB) to move fast over a phone's uplink.
function captureBlob(cb, w = 480, q = 0.5) {
  const v = $('video');
  if (!v.videoWidth) return cb(null);
  const h = Math.round((v.videoHeight / v.videoWidth) * w) || Math.round(w * 0.75);
  const c = $('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  c.toBlob((blob) => {
    if (!blob) return cb(null);
    blob.arrayBuffer().then(cb).catch(() => cb(null));
  }, 'image/jpeg', q);
}

// ---------- monitoring scan ----------
async function scan() {
  // Pause auto-scan while the officer is watching live — the heavy analysis capture +
  // upload would otherwise stutter the live feed every few seconds. Resumes on close.
  if (!st.stream || st.busy || st.dispatch || st.awaitingReview || st.liveRunning) return;
  const image = captureFrame(true); // auto-scan needs the brightness reading
  if (!image) return;
  // On real monitoring (Auto scenario), skip near-black frames — a covered/dark
  // camera shouldn't trigger analysis (and never a false alert).
  if ($('scenario').value === 'auto' && st.lastBrightness != null && st.lastBrightness < 10) {
    const d = st.drones.find((x) => x.id === st.droneId);
    setStatus('mon', `Camera dark — skipping · ${d ? d.sector : ''}`);
    return;
  }
  st.busy = true;
  $('scanBtn').disabled = true;
  try {
    const res = await api('/api/analyze', {
      method: 'POST',
      body: {
        droneId: st.droneId,
        image,
        lat: st.coords.lat,
        lng: st.coords.lng,
        scenarioHint: $('scenario').value
      }
    });
    // A dispatch may have arrived (or the camera stopped) while we were waiting.
    if (st.dispatch || !st.stream) return;
    showVerdict(res.analysis);
    if (res.alert) {
      st.awaitingReview = true;
      setStatus('wait', `⚠ Alert sent: ${res.alert.title} — awaiting police review`);
    } else {
      const d = st.drones.find((x) => x.id === st.droneId);
      setStatus('mon', `All clear · ${d ? d.sector : ''} — monitoring`);
    }
  } catch (e) {
    console.error(e);
  } finally {
    st.busy = false;
    if (st.stream && !st.dispatch && !st.awaitingReview) $('scanBtn').disabled = false;
  }
}

function showVerdict(a) {
  const m = incidentMeta(a.incidentType);
  const v = $('verdict');
  v.classList.remove('hidden');
  $('vTitle').innerHTML = `${incidentIcon(a.incidentType)} ${esc(a.title)} <span class="chip" style="margin-left:6px">${Math.round(a.confidence * 100)}%</span>`;
  $('vTitle').style.color = m.color;
  $('vInterp').textContent = a.interpretation;
  refreshIcons();
}

function updateAuto() {
  if (st.autoTimer) clearInterval(st.autoTimer), (st.autoTimer = null);
  if ($('autoChk').checked && st.stream && !st.dispatch) {
    const ms = Number($('interval').value) || 8000;
    st.autoTimer = setInterval(scan, ms);
    scan();
  }
}

// ---------- dispatch mode ----------
function enterDispatch(cmd) {
  st.dispatch = { dispatchId: cmd.dispatchId, address: cmd.address, droneId: st.droneId, lat: cmd.lat, lng: cmd.lng };
  st.awaitingReview = false;
  if (st.autoTimer) clearInterval(st.autoTimer), (st.autoTimer = null);
  $('droneSel').disabled = true; // don't let the operator swap drones mid-dispatch
  const m = incidentMeta(cmd.incidentType);
  $('dispatchBanner').classList.add('show');
  $('dispatchInfo').innerHTML = `${incidentIcon(cmd.incidentType)} <b>${esc(m.label)}</b> at <b>${esc(cmd.address || 'target location')}</b>. ${esc(cmd.description || '')} — proceed & stream live to police.`;
  setStatus('disp', 'DISPATCHED — streaming live to police');
  $('scanBtn').disabled = true;
  updateDispatchTracker();
  refreshIcons();

  if (!st.stream) {
    // camera not started — prompt to start so streaming can begin
    setStatus('disp', 'DISPATCHED — press "Start camera" to stream live footage');
  }
  startStreaming();
}

// Binary dispatch footage over the WebSocket — same smooth path as the live camera:
// tiny frames + a few in flight (so fps isn't gated by round-trip latency). The drone
// leaves dispatch mode on the server's "resume" command, not on a send error.
function startStreaming() {
  if (st.streamRunning) return; // already looping; it reads st.dispatch each tick
  st.streamRunning = true;
  const INTERVAL = 90; // ~11 fps capture cadence
  const CAP = 3; // frames allowed in flight before we skip
  let inFlight = 0;
  const tick = () => {
    if (!st.streamRunning) return;
    if (st.dispatch && st.stream && inFlight < CAP) {
      inFlight++;
      captureBlob((buf) => {
        if (!st.streamRunning || !st.dispatch || !buf) { inFlight = Math.max(0, inFlight - 1); return; }
        socket.timeout(1500).emit('drone:dispframe', st.dispatch.dispatchId, st.dispatch.droneId, buf,
          () => { inFlight = Math.max(0, inFlight - 1); });
      });
    }
    st.streamTimer = setTimeout(tick, INTERVAL);
  };
  tick();
}

function exitDispatch(message) {
  st.streamRunning = false;
  if (st.streamTimer) clearTimeout(st.streamTimer), (st.streamTimer = null);
  st.dispatch = null;
  st.awaitingReview = false; // a resume also clears an "awaiting review" alert
  $('dispatchBanner').classList.remove('show');
  $('dispatchTracker').style.display = 'none';
  $('droneSel').disabled = false;
  const d = st.drones.find((x) => x.id === st.droneId);
  setStatus('mon', message || `Resumed monitoring · ${d ? d.sector : ''}`);
  if (st.stream) $('scanBtn').disabled = false;
  updateAuto();
}

// ---------- on-demand live view (police requested) ----------
function startLive() {
  $('liveChip').classList.add('show');
  if (st.liveRunning) return;
  st.liveRunning = true;
  const liveDroneId = st.droneId; // keep streaming this drone even if selection changes
  const INTERVAL = 80; // capture cadence (~12 fps ceiling)
  const CAP = 3; // frames allowed in flight before we skip — decouples fps from round-trip
  //             latency (strict 1-at-a-time capped us at one frame per RTT = choppy).
  let inFlight = 0;
  const tick = () => {
    if (!st.liveRunning) return;
    if (st.stream && inFlight < CAP) {
      inFlight++;
      captureBlob((buf) => {
        if (!st.liveRunning || !buf) { inFlight = Math.max(0, inFlight - 1); return; }
        // socket.timeout so the ack ALWAYS fires (on receipt or after 1.5s) — inFlight
        // can never get stuck if a frame is dropped.
        socket.timeout(1500).emit('drone:liveframe', liveDroneId, buf, () => { inFlight = Math.max(0, inFlight - 1); });
      });
    }
    st.liveTimer = setTimeout(tick, INTERVAL);
  };
  tick();
}

function stopLive() {
  st.liveRunning = false;
  if (st.liveTimer) clearTimeout(st.liveTimer), (st.liveTimer = null);
  $('liveChip').classList.remove('show');
}

// ---------- gps (live location tracking) ----------
function useSeedCoords() {
  const d = st.drones.find((x) => x.id === st.droneId);
  if (d) st.coords = { lat: d.lat, lng: d.lng };
}

// Push the drone's current position + battery to the police map (throttled),
// even when it isn't scanning — this is what makes the map track it live.
function sendLocation(force) {
  const now = Date.now();
  if (!force && now - st.lastLocSent < 2500) return;
  st.lastLocSent = now;
  const msg = { droneId: st.droneId, lat: st.coords.lat, lng: st.coords.lng };
  if (st.battery != null) msg.battery = st.battery;
  socket.emit('drone:location', msg);
  if (st.dispatch) updateDispatchTracker();
}

// ---------- distance + compass direction to the dispatch target ----------
function haversineKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function bearingDeg(from, to) {
  const toRad = (x) => (x * Math.PI) / 180, toDeg = (x) => (x * 180) / Math.PI;
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(to.lat));
  const x = Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) - Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
const COMPASS = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];
function updateDispatchTracker() {
  if (!st.dispatch || typeof st.dispatch.lat !== 'number') return;
  const target = { lat: st.dispatch.lat, lng: st.dispatch.lng };
  const km = haversineKm(st.coords, target);
  const brng = bearingDeg(st.coords, target);
  const distTxt = km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(2)} km away`;
  $('dispatchTracker').style.display = 'flex';
  $('trackerDist').textContent = distTxt;
  $('trackerDir').textContent =
    km * 1000 <= 20 ? 'You have arrived at the target.' : `Head ${COMPASS[Math.round(brng / 45) % 8]} (${Math.round(brng)}°)`;
  // The navigation icon points "up" (north); rotate it toward the target bearing.
  const arrow = $('trackerArrow').querySelector('svg') || $('trackerArrow');
  arrow.style.transform = `rotate(${brng}deg)`;
}

function toggleGps() {
  const status = $('gpsStatus');
  if ($('gpsChk').checked) {
    if (!navigator.geolocation) {
      status.textContent = 'GPS not supported on this device — using sector location.';
      $('gpsChk').checked = false;
      return;
    }
    status.innerHTML = `${icon('locate-fixed')} acquiring GPS…`;
    refreshIcons();
    st.gpsWatch = navigator.geolocation.watchPosition(
      (pos) => {
        st.coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        status.innerHTML = `${icon('locate-fixed')} live: ${st.coords.lat.toFixed(5)}, ${st.coords.lng.toFixed(5)}`;
        refreshIcons();
        sendLocation();
      },
      (err) => {
        status.textContent = `GPS unavailable (${err.message}) — using sector location.`;
        $('gpsChk').checked = false;
        if (st.gpsWatch != null) navigator.geolocation.clearWatch(st.gpsWatch);
        st.gpsWatch = null;
        useSeedCoords();
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  } else {
    if (st.gpsWatch != null) navigator.geolocation.clearWatch(st.gpsWatch);
    st.gpsWatch = null;
    useSeedCoords();
    sendLocation();
    status.textContent = 'GPS off — using assigned sector location.';
  }
}

// ---------- status strip ----------
function setStatus(kind, text) {
  const s = $('statusStrip');
  s.className = 'status-strip ' + kind;
  $('statusText').textContent = text;
}
