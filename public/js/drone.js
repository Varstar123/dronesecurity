import { api, esc, loadConfig, CONFIG, incidentMeta } from '/js/common.js';

const socket = io();
const $ = (id) => document.getElementById(id);

const st = {
  droneId: null,
  coords: { lat: CONFIG.cityCenter.lat, lng: CONFIG.cityCenter.lng },
  drones: [],
  stream: null,
  autoTimer: null,
  streamTimer: null,
  liveTimer: null, // on-demand live view requested by police
  dispatch: null, // { dispatchId, address, droneId }
  gpsWatch: null,
  busy: false,
  awaitingReview: false // an alert was raised and is waiting for police review
};

init();
async function init() {
  await loadConfig();
  const badge = $('aiBadge');
  badge.textContent = `AI: ${CONFIG.aiLabel || 'Simulation'}`;
  badge.className = 'badge ' + (CONFIG.aiMode === 'mock' ? 'mock' : 'live');

  // scenario select (mock AI only)
  const opts = ['<option value="auto">Auto (random)</option>']
    .concat(Object.entries(CONFIG.incidentTypes).map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`));
  $('scenario').innerHTML = opts.join('');

  st.drones = await api('/api/drones');
  $('droneSel').innerHTML = st.drones.map((d) => `<option value="${d.id}">${esc(d.name)} — ${esc(d.sector)}</option>`).join('');
  selectDrone(st.drones[0].id);

  $('droneSel').onchange = () => selectDrone($('droneSel').value);
  $('startCam').onclick = startCamera;
  $('scanBtn').onclick = () => scan();
  $('stopCam').onclick = stopCamera;
  $('autoChk').onchange = updateAuto;
  $('interval').onchange = updateAuto;
  $('gpsChk').onchange = toggleGps;

  wireSocket();
}

function selectDrone(id) {
  st.droneId = id;
  const d = st.drones.find((x) => x.id === id);
  if (d && !$('gpsChk').checked) st.coords = { lat: d.lat, lng: d.lng };
  socket.emit('drone:hello', { droneId: id });
  setStatus('mon', d ? `Monitoring · ${d.sector}` : 'Monitoring');
}

function wireSocket() {
  socket.on('connect', () => { if (st.droneId) socket.emit('drone:hello', { droneId: st.droneId }); });
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
  if (st.streamTimer) clearInterval(st.streamTimer), (st.streamTimer = null);
  if (st.liveTimer) clearInterval(st.liveTimer), (st.liveTimer = null);
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
  $('scanBtn').disabled = true;
  $('stopCam').disabled = true;
  $('autoChk').checked = false;
  setStatus('mon', wasDispatch ? 'Camera stopped — dispatch streaming halted' : 'Camera stopped');
}

function captureFrame() {
  const v = $('video');
  if (!v.videoWidth) return null;
  const w = 640;
  const h = Math.round((v.videoHeight / v.videoWidth) * w) || 480;
  const c = $('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.6);
}

// ---------- monitoring scan ----------
async function scan() {
  if (!st.stream || st.busy || st.dispatch || st.awaitingReview) return;
  const image = captureFrame();
  if (!image) return;
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
  $('vTitle').innerHTML = `${m.icon} ${esc(a.title)} <span class="chip" style="margin-left:6px">${Math.round(a.confidence * 100)}%</span>`;
  $('vTitle').style.color = m.color;
  $('vInterp').textContent = a.interpretation;
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
  st.dispatch = { dispatchId: cmd.dispatchId, address: cmd.address, droneId: st.droneId };
  st.awaitingReview = false;
  if (st.autoTimer) clearInterval(st.autoTimer), (st.autoTimer = null);
  $('droneSel').disabled = true; // don't let the operator swap drones mid-dispatch
  const m = incidentMeta(cmd.incidentType);
  $('dispatchBanner').classList.add('show');
  $('dispatchInfo').innerHTML = `${m.icon} <b>${esc(m.label)}</b> at <b>${esc(cmd.address || 'target location')}</b>. ${esc(cmd.description || '')} — surrounding &amp; streaming live to police.`;
  setStatus('disp', `🚨 DISPATCHED — streaming live to police`);
  $('scanBtn').disabled = true;

  if (!st.stream) {
    // camera not started — prompt to start so streaming can begin
    setStatus('disp', '🚨 DISPATCHED — press "Start camera" to stream live footage');
  }
  startStreaming();
}

function startStreaming() {
  if (st.streamTimer) clearInterval(st.streamTimer);
  st.streamTimer = setInterval(async () => {
    if (!st.dispatch || !st.stream) return;
    const image = captureFrame();
    if (!image) return;
    try {
      await api(`/api/dispatches/${st.dispatch.dispatchId}/frame`, {
        method: 'POST',
        body: { droneId: st.dispatch.droneId, image }
      });
    } catch (e) {
      // dispatch may have been resolved
      if (String(e.message).includes('not active') || String(e.message).includes('unknown')) exitDispatch();
    }
  }, 2000);
}

function exitDispatch(message) {
  if (st.streamTimer) clearInterval(st.streamTimer), (st.streamTimer = null);
  st.dispatch = null;
  st.awaitingReview = false; // a resume also clears an "awaiting review" alert
  $('dispatchBanner').classList.remove('show');
  $('droneSel').disabled = false;
  const d = st.drones.find((x) => x.id === st.droneId);
  setStatus('mon', message || `Resumed monitoring · ${d ? d.sector : ''}`);
  if (st.stream) $('scanBtn').disabled = false;
  updateAuto();
}

// ---------- on-demand live view (police requested) ----------
function startLive() {
  $('liveChip').classList.add('show');
  if (st.liveTimer) return;
  const liveDroneId = st.droneId; // keep streaming this drone even if selection changes
  st.liveTimer = setInterval(async () => {
    if (!st.stream) return; // wait until the camera is on
    const image = captureFrame();
    if (!image) return;
    try {
      await api(`/api/drones/${liveDroneId}/live/frame`, { method: 'POST', body: { image } });
    } catch (e) {
      /* police may have closed the view */
    }
  }, 1000);
}

function stopLive() {
  if (st.liveTimer) clearInterval(st.liveTimer), (st.liveTimer = null);
  $('liveChip').classList.remove('show');
}

// ---------- gps ----------
function toggleGps() {
  if ($('gpsChk').checked) {
    if (!navigator.geolocation) { alert('Geolocation not available'); $('gpsChk').checked = false; return; }
    st.gpsWatch = navigator.geolocation.watchPosition(
      (pos) => { st.coords = { lat: pos.coords.latitude, lng: pos.coords.longitude }; },
      (err) => { console.warn('gps', err.message); },
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
  } else {
    if (st.gpsWatch != null) navigator.geolocation.clearWatch(st.gpsWatch);
    st.gpsWatch = null;
    const d = st.drones.find((x) => x.id === st.droneId);
    if (d) st.coords = { lat: d.lat, lng: d.lng };
  }
}

// ---------- status strip ----------
function setStatus(kind, text) {
  const s = $('statusStrip');
  s.className = 'status-strip ' + kind;
  $('statusText').textContent = text;
}
