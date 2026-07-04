import 'dotenv/config';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';

import express from 'express';
import { Server as SocketServer } from 'socket.io';

import { db, UPLOAD_DIR } from './src/db.js';
import * as supa from './src/supa.js';
import { seedFleet, CITY_CENTER, LANDMARKS } from './src/seed.js';
import { analyzeFrame, AI_MODE, AI_LABEL } from './src/ai.js';
import { findNearbyDrones, haversineKm } from './src/geo.js';
import { INCIDENT_TYPES, meta } from './src/incidents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || PORT + 443; // 3443 by default
const MAX_FRAMES_PER_DISPATCH = 16;
// Police authorization key required to clear captured images (change via .env).
const CLEAR_SECRET = process.env.CLEAR_SECRET || 'police2026';
// A drone counts as "reached the location" within this distance of the target.
const ARRIVAL_RADIUS_KM = 0.02; // 20 metres

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, { maxHttpBufferSize: 12e6 });

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/drone', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'drone.html')));

// ---- helpers -------------------------------------------------------------

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function stripBase64(dataUrl) {
  if (typeof dataUrl !== 'string') return '';
  const comma = dataUrl.indexOf(',');
  return dataUrl.startsWith('data:') && comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl;
}

// Save a captured frame. Uploads to Supabase Storage when enabled (returns a
// public URL); otherwise writes a local file served at /uploads.
async function saveImage(dataUrl) {
  const b64 = stripBase64(dataUrl);
  if (!b64) return null;
  const name = `${uid('img')}.jpg`;
  const buffer = Buffer.from(b64, 'base64');
  if (supa.SUPA_ENABLED) {
    try {
      return await supa.uploadImage(buffer, name);
    } catch (err) {
      console.warn('[img] Storage upload failed, using local file:', err.message);
    }
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  return `/uploads/${name}`;
}

function clearLocalUploads() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      fs.unlinkSync(path.join(UPLOAD_DIR, f));
      n++;
    }
  } catch {
    /* nothing to clear */
  }
  return n;
}

const toPolice = (event, data) => io.to('police').emit(event, data);
const toDrone = (droneId, event, data) => io.to(`drone:${droneId}`).emit(event, data);

function droneStatus(drone) {
  drone.lastSeen = new Date().toISOString();
  db.save();
  toPolice('drone:status', drone);
}

function stats() {
  const alerts = db.alerts();
  const dispatches = db.dispatches();
  return {
    dronesOnline: db.drones().filter((d) => d.connected).length,
    dronesTotal: db.drones().length,
    pendingAlerts: alerts.filter((a) => a.status === 'pending_review').length,
    escalated: alerts.filter((a) => a.status === 'escalated').length,
    dismissed: alerts.filter((a) => a.status === 'dismissed').length,
    activeDispatches: dispatches.filter((d) => d.status === 'active').length,
    mainForce: db.mainForce().length
  };
}

const pushStats = () => toPolice('stats', stats());

// ---- dispatch arrival detection -----------------------------------------

// If a drone is within ARRIVAL_RADIUS_KM of its dispatch target, mark it
// arrived once and alert the police ("Drone X reached the location").
function checkArrival(drone, dispatch) {
  if (!dispatch || dispatch.status !== 'active') return;
  if (dispatch.arrived.some((a) => a.droneId === drone.id)) return;
  const dist = haversineKm({ lat: drone.lat, lng: drone.lng }, { lat: dispatch.lat, lng: dispatch.lng });
  if (dist > ARRIVAL_RADIUS_KM) return;

  const rec = { droneId: drone.id, droneName: drone.name, at: new Date().toISOString(), distanceKm: +dist.toFixed(3) };
  dispatch.arrived.push(rec);
  const ad = dispatch.assignedDrones.find((a) => a.id === drone.id);
  if (ad) ad.arrived = true;
  db.save();
  toPolice('dispatch:arrived', { dispatchId: dispatch.id, ...rec });
  toPolice('dispatch:updated', dispatch);
}

// ---- read endpoints ------------------------------------------------------

app.get('/api/config', (_req, res) => {
  res.json({ aiMode: AI_MODE, aiLabel: AI_LABEL, cityCenter: CITY_CENTER, incidentTypes: INCIDENT_TYPES, landmarks: LANDMARKS });
});

app.get('/api/drones', (_req, res) => res.json(db.drones()));

app.get('/api/alerts', (req, res) => {
  let list = db.alerts();
  if (req.query.status) list = list.filter((a) => a.status === req.query.status);
  res.json([...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
});

app.get('/api/dispatches', (_req, res) =>
  res.json([...db.dispatches()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)))
);

app.get('/api/mainforce', (_req, res) =>
  res.json([...db.mainForce()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)))
);

app.get('/api/stats', (_req, res) => res.json(stats()));

// ---- drone: analyze a captured frame ------------------------------------

app.post('/api/analyze', async (req, res) => {
  const { droneId, image, lat, lng, scenarioHint } = req.body || {};
  const drone = db.find('drones', droneId);
  if (!drone) return res.status(404).json({ error: 'unknown drone' });

  if (typeof lat === 'number' && typeof lng === 'number') {
    drone.lat = lat;
    drone.lng = lng;
  }
  drone.connected = true;
  drone.lastSeen = new Date().toISOString();

  let analysis;
  try {
    analysis = await analyzeFrame(stripBase64(image), {
      droneId: drone.id,
      droneName: drone.name,
      sector: drone.sector,
      scenarioHint
    });
  } catch (err) {
    console.error('[analyze] failed:', err.message);
    return res.status(500).json({ error: 'analysis failed' });
  }

  const m = meta(analysis.incidentType);
  let alert = null;

  if (analysis.incidentType !== 'normal' && m.policeRelevant) {
    // Avoid piling up duplicate alerts while one is still awaiting review for this drone.
    const existing = db.alerts().find((a) => a.droneId === drone.id && a.status === 'pending_review');
    if (existing) {
      alert = existing;
      db.save();
    } else {
      const imageUrl = await saveImage(image);
      alert = {
        id: uid('alert'),
        droneId: drone.id,
        droneName: drone.name,
        sector: drone.sector,
        lat: drone.lat,
        lng: drone.lng,
        timestamp: new Date().toISOString(),
        imageUrl,
        incidentType: analysis.incidentType,
        title: analysis.title,
        severity: analysis.severity,
        confidence: analysis.confidence,
        interpretation: analysis.interpretation,
        recommendedAction: analysis.recommendedAction,
        source: analysis.source,
        status: 'pending_review',
        reviewedBy: null,
        reviewedAt: null,
        reviewNote: null
      };
      db.alerts().push(alert);
      drone.status = 'alerting';
      db.save();

      toPolice('alert:new', alert);
      droneStatus(drone);
      pushStats();
    }
  } else {
    // Normal scan — still push live telemetry (position + online) so the map stays current.
    droneStatus(drone);
    pushStats();
  }

  res.json({ analysis, alert });
});

// ---- drone police: act on an alert --------------------------------------

app.post('/api/alerts/:id/escalate', (req, res) => {
  const alert = db.find('alerts', req.params.id);
  if (!alert) return res.status(404).json({ error: 'unknown alert' });
  if (alert.status !== 'pending_review')
    return res.status(409).json({ error: `alert already ${alert.status}` });

  const { officer = 'Drone Police', note = '' } = req.body || {};
  alert.status = 'escalated';
  alert.reviewedBy = officer;
  alert.reviewedAt = new Date().toISOString();
  alert.reviewNote = note;

  const record = {
    id: uid('mf'),
    timestamp: new Date().toISOString(),
    sourceType: 'alert',
    sourceId: alert.id,
    incidentType: alert.incidentType,
    title: alert.title,
    location: alert.sector,
    lat: alert.lat,
    lng: alert.lng,
    droneName: alert.droneName,
    officer,
    conveyed: note || `${meta(alert.incidentType).label} confirmed by drone police — response requested.`
  };
  db.mainForce().push(record);

  const drone = db.find('drones', alert.droneId);
  // Don't yank a drone off an active dispatch just because an older alert was reviewed.
  if (drone && !drone.activeDispatchId && drone.status !== 'dispatched') {
    drone.status = 'monitoring';
    toDrone(drone.id, 'drone:command', {
      type: 'resume',
      message: 'Alert escalated to main force. Resume monitoring.'
    });
  }
  db.save();

  toPolice('alert:updated', alert);
  toPolice('mainforce:new', record);
  if (drone) droneStatus(drone);
  pushStats();
  res.json({ alert, record });
});

app.post('/api/alerts/:id/dismiss', (req, res) => {
  const alert = db.find('alerts', req.params.id);
  if (!alert) return res.status(404).json({ error: 'unknown alert' });
  if (alert.status !== 'pending_review')
    return res.status(409).json({ error: `alert already ${alert.status}` });

  const { officer = 'Drone Police', note = '' } = req.body || {};
  alert.status = 'dismissed';
  alert.reviewedBy = officer;
  alert.reviewedAt = new Date().toISOString();
  alert.reviewNote = note;

  const drone = db.find('drones', alert.droneId);
  if (drone && !drone.activeDispatchId && drone.status !== 'dispatched') {
    drone.status = 'monitoring';
    toDrone(drone.id, 'drone:command', {
      type: 'resume',
      message: note ? `Situation OK: ${note}. Resume monitoring.` : 'Situation OK. Resume monitoring.'
    });
  }
  db.save();

  toPolice('alert:updated', alert);
  if (drone) droneStatus(drone);
  pushStats();
  res.json({ alert });
});

// ---- main force -> drone dispatch (surround a location) ------------------

app.post('/api/dispatches', (req, res) => {
  const { lat, lng, address = '', incidentType = 'suspicious_activity', description = '', officer = 'Main Force', radiusKm } =
    req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number')
    return res.status(400).json({ error: 'lat/lng required' });

  const nearby = findNearbyDrones({ lat, lng }, db.drones(), {
    radiusKm: typeof radiusKm === 'number' ? radiusKm : 3
  });
  if (nearby.length === 0) {
    const online = db.drones().filter((d) => d.connected).length;
    if (online === 0)
      return res.status(409).json({
        error: 'No drones are online. Open the drone app on a phone (so a drone comes online) before dispatching.'
      });
    return res.status(409).json({
      error: `Your ${online} online drone(s) are already on an active dispatch. Resolve that dispatch first to free a drone, then dispatch again.`
    });
  }

  const dispatch = {
    id: uid('disp'),
    timestamp: new Date().toISOString(),
    lat,
    lng,
    address,
    incidentType,
    description,
    officer,
    status: 'active',
    assignedDrones: nearby.map((d) => ({
      id: d.id,
      name: d.name,
      sector: d.sector,
      distanceKm: +d.distanceKm.toFixed(2)
    })),
    frames: [],
    updates: [],
    arrived: [],
    resolvedAt: null
  };
  db.dispatches().push(dispatch);

  for (const nd of nearby) {
    const drone = db.find('drones', nd.id);
    drone.status = 'dispatched';
    drone.activeDispatchId = dispatch.id;
    toDrone(drone.id, 'drone:command', {
      type: 'dispatch',
      dispatchId: dispatch.id,
      incidentType,
      address,
      description,
      lat,
      lng,
      message: `DISPATCH: proceed to ${address || 'target location'} and stream live footage.`
    });
  }
  db.save();

  toPolice('dispatch:new', dispatch);
  for (const nd of nearby) {
    const drone = db.find('drones', nd.id);
    if (drone) toPolice('drone:status', drone);
  }
  // Dispatched drones reach the target via their real GPS; check if any are
  // already within range right now.
  for (const nd of nearby) {
    const drone = db.find('drones', nd.id);
    if (drone) checkArrival(drone, dispatch);
  }
  pushStats();
  res.json(dispatch);
});

// ---- dispatched drone streams a live frame ------------------------------

app.post('/api/dispatches/:id/frame', async (req, res) => {
  const dispatch = db.find('dispatches', req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'unknown dispatch' });
  if (dispatch.status !== 'active') return res.status(409).json({ error: 'dispatch not active' });

  const { droneId, image } = req.body || {};
  const drone = db.find('drones', droneId);
  if (!drone) return res.status(404).json({ error: 'unknown drone' });

  const url = await saveImage(image);
  if (!url) return res.status(400).json({ error: 'no image' });

  const frame = {
    id: uid('frame'),
    droneId: drone.id,
    droneName: drone.name,
    url,
    at: new Date().toISOString()
  };
  dispatch.frames.push(frame);
  if (dispatch.frames.length > MAX_FRAMES_PER_DISPATCH)
    dispatch.frames = dispatch.frames.slice(-MAX_FRAMES_PER_DISPATCH);
  db.save();

  toPolice('dispatch:frame', { dispatchId: dispatch.id, frame });
  res.json({ ok: true, frame });
});

// ---- drone police conveys info about a dispatch to main force ------------

app.post('/api/dispatches/:id/convey', (req, res) => {
  const dispatch = db.find('dispatches', req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'unknown dispatch' });
  const body = req.body || {};
  const info = typeof body.info === 'string' ? body.info : '';
  const officer = typeof body.officer === 'string' ? body.officer : 'Drone Police';
  if (!info.trim()) return res.status(400).json({ error: 'info required' });

  const update = { id: uid('upd'), at: new Date().toISOString(), officer, info };
  dispatch.updates.push(update);

  const record = {
    id: uid('mf'),
    timestamp: update.at,
    sourceType: 'dispatch',
    sourceId: dispatch.id,
    incidentType: dispatch.incidentType,
    title: `Field update — ${meta(dispatch.incidentType).label}`,
    location: dispatch.address || `${dispatch.lat.toFixed(4)}, ${dispatch.lng.toFixed(4)}`,
    lat: dispatch.lat,
    lng: dispatch.lng,
    droneName: dispatch.assignedDrones.map((d) => d.name).join(', '),
    officer,
    conveyed: info
  };
  db.mainForce().push(record);
  db.save();

  toPolice('dispatch:updated', dispatch);
  toPolice('mainforce:new', record);
  pushStats();
  res.json({ dispatch, record });
});

// ---- resolve a dispatch --------------------------------------------------

app.post('/api/dispatches/:id/resolve', (req, res) => {
  const dispatch = db.find('dispatches', req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'unknown dispatch' });
  if (dispatch.status !== 'active') return res.status(409).json({ error: 'already resolved' });

  dispatch.status = 'resolved';
  dispatch.resolvedAt = new Date().toISOString();

  for (const ad of dispatch.assignedDrones) {
    const drone = db.find('drones', ad.id);
    if (drone && drone.activeDispatchId === dispatch.id) {
      drone.status = 'monitoring';
      drone.activeDispatchId = null;
      toDrone(drone.id, 'drone:command', { type: 'resume', message: 'Dispatch resolved. Resume monitoring.' });
    }
  }
  db.save();

  toPolice('dispatch:resolved', dispatch);
  for (const ad of dispatch.assignedDrones) {
    const drone = db.find('drones', ad.id);
    if (drone) toPolice('drone:status', drone);
  }
  pushStats();
  res.json(dispatch);
});

// ---- police: on-demand live camera from an active drone ------------------

app.post('/api/drones/:id/live/start', (req, res) => {
  const drone = db.find('drones', req.params.id);
  if (!drone) return res.status(404).json({ error: 'unknown drone' });
  if (!drone.connected) return res.status(409).json({ error: 'drone is offline' });
  drone.liveView = true;
  db.save();
  toDrone(drone.id, 'drone:command', { type: 'livestream' });
  toPolice('drone:status', drone);
  res.json({ ok: true });
});

app.post('/api/drones/:id/live/stop', (req, res) => {
  const drone = db.find('drones', req.params.id);
  if (!drone) return res.status(404).json({ error: 'unknown drone' });
  drone.liveView = false;
  db.save();
  toDrone(drone.id, 'drone:command', { type: 'livestream_stop' });
  toPolice('drone:status', drone);
  res.json({ ok: true });
});

app.post('/api/drones/:id/live/frame', (req, res) => {
  const drone = db.find('drones', req.params.id);
  if (!drone) return res.status(404).json({ error: 'unknown drone' });
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'no image' });
  if (!drone.liveView) return res.json({ ok: true, ignored: true }); // nobody is watching
  // Relay live frames to the portal in memory (not saved to disk).
  toPolice('live:frame', { droneId: drone.id, image, at: new Date().toISOString() });
  res.json({ ok: true });
});

// ---- demo reset (keeps the fleet, clears incidents) ----------------------

app.post('/api/admin/reset', (_req, res) => {
  db.state.alerts = [];
  db.state.dispatches = [];
  db.state.mainForce = [];
  for (const d of db.drones()) {
    d.status = 'monitoring';
    d.activeDispatchId = null;
    d.liveView = false;
  }
  db.save();
  toPolice('refresh', {});
  for (const d of db.drones()) {
    toDrone(d.id, 'drone:command', { type: 'livestream_stop' });
    toDrone(d.id, 'drone:command', { type: 'resume', message: 'System reset.' });
  }
  pushStats();
  res.json({ ok: true });
});

// ---- police: clear captured images (authorization-key protected) --------

app.post('/api/admin/clear-images', async (req, res) => {
  const { secretKey, mode } = req.body || {};
  if (secretKey !== CLEAR_SECRET) return res.status(403).json({ error: 'Invalid authorization key' });

  let cleared = 0;
  try {
    cleared = supa.SUPA_ENABLED ? await supa.clearImages() : clearLocalUploads();
  } catch (err) {
    return res.status(500).json({ error: 'failed to clear images: ' + err.message });
  }

  // Drop image references so the portal shows placeholders instead of dead links.
  for (const a of db.alerts()) a.imageUrl = null;
  for (const d of db.dispatches()) d.frames = [];
  db.save();

  toPolice('refresh', {});
  const archived = mode === 'archive';
  res.json({
    ok: true,
    cleared,
    message: archived
      ? `Archived to police server — ${cleared} image(s) moved, drone cache cleared.`
      : `${cleared} captured image(s) cleared from drone storage.`
  });
});

// ---- sockets -------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('police:join', () => {
    socket.join('police');
    socket.emit('stats', stats());
  });

  socket.on('drone:hello', ({ droneId } = {}) => {
    const drone = db.find('drones', droneId);
    if (!drone) return;
    // If this socket was previously controlling a different drone, leave that
    // room and mark the old drone offline if nobody else controls it.
    const prev = socket.data.droneId;
    if (prev && prev !== droneId) {
      socket.leave(`drone:${prev}`);
      const prevRoom = io.sockets.adapter.rooms.get(`drone:${prev}`);
      if (!prevRoom || prevRoom.size === 0) {
        const prevDrone = db.find('drones', prev);
        if (prevDrone) {
          prevDrone.connected = false;
          toPolice('drone:status', prevDrone);
        }
      }
    }
    socket.data.droneId = droneId;
    socket.join(`drone:${droneId}`);
    drone.connected = true;
    drone.lastSeen = new Date().toISOString();
    db.save();
    toPolice('drone:status', drone);
    pushStats();
    // If this drone already has an active dispatch, re-send the command.
    if (drone.activeDispatchId) {
      const dispatch = db.find('dispatches', drone.activeDispatchId);
      if (dispatch && dispatch.status === 'active') {
        socket.emit('drone:command', {
          type: 'dispatch',
          dispatchId: dispatch.id,
          incidentType: dispatch.incidentType,
          address: dispatch.address,
          description: dispatch.description,
          lat: dispatch.lat,
          lng: dispatch.lng,
          message: `DISPATCH: proceed to ${dispatch.address || 'target location'} and stream live footage.`
        });
      }
    }
    // Resume an on-demand live view if the police were watching this drone.
    if (drone.liveView) socket.emit('drone:command', { type: 'livestream' });
  });

  // Live GPS position from a drone → update the fleet map in real time.
  socket.on('drone:location', ({ droneId, lat, lng } = {}) => {
    if (typeof lat !== 'number' || typeof lng !== 'number') return;
    const drone = db.find('drones', droneId);
    if (!drone) return;
    drone.lat = lat;
    drone.lng = lng;
    drone.connected = true;
    drone.lastSeen = new Date().toISOString();
    db.save();
    toPolice('drone:status', drone);
    // If this drone is on a dispatch, check whether it has reached the target.
    if (drone.activeDispatchId) {
      const dispatch = db.find('dispatches', drone.activeDispatchId);
      if (dispatch) checkArrival(drone, dispatch);
    }
  });

  socket.on('disconnect', () => {
    const droneId = socket.data.droneId;
    if (!droneId) return;
    // Only mark offline if no other socket controls this drone.
    const room = io.sockets.adapter.rooms.get(`drone:${droneId}`);
    if (room && room.size > 0) return;
    const drone = db.find('drones', droneId);
    if (drone) {
      drone.connected = false;
      drone.liveView = false;
      db.save();
      toPolice('drone:status', drone);
      pushStats();
    }
  });
});

// ---- start ---------------------------------------------------------------

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// A self-signed cert ships in ./certs so the phone camera works over Wi-Fi
// with no extra setup. If it is missing we try to regenerate it with openssl.
function loadOrCreateCerts() {
  const dir = path.join(__dirname, 'certs');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
       '-days', '3650', '-subj', '/CN=smart-drone.local',
       '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { stdio: 'ignore' }
    );
    if (r.status === 0 && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
  } catch {
    /* openssl not available */
  }
  return null;
}

function startHttps() {
  // Managed hosts (Render/Railway/etc.) terminate TLS at their edge and give a
  // public https:// URL, so the local self-signed listener isn't needed there.
  if (process.env.NODE_ENV === 'production' || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT) {
    return false;
  }
  const creds = loadOrCreateCerts();
  if (!creds) {
    console.warn('[https] no certificate available — phone-over-WiFi camera disabled (HTTP only).');
    return false;
  }
  try {
    const httpsServer = https.createServer(creds, app);
    io.attach(httpsServer); // same real-time layer on the secure port
    httpsServer.listen(HTTPS_PORT, '0.0.0.0');
    return true;
  } catch (err) {
    console.warn('[https] could not start secure server (phone camera needs it):', err.message);
    return false;
  }
}

async function start() {
  await db.init(); // load state from Supabase (or local JSON)
  seedFleet(); // seed the fleet if it's empty; reconcile stale state otherwise

  server.listen(PORT, '0.0.0.0', () => {
    const httpsOk = startHttps();
    const ips = lanIPs();
    console.log('\n  🛰️  Smart City Drone Security System');
    console.log(`  AI analysis     : ${AI_LABEL}`);
    console.log(`  Data store      : ${supa.SUPA_ENABLED ? 'Supabase (Postgres + image bucket)' : 'local JSON + files'}`);
    console.log('  ---------------------------------------------');
    console.log('  ON THIS COMPUTER (camera works on localhost):');
    console.log(`    Police portal    : http://localhost:${PORT}/`);
    console.log(`    Drone camera app : http://localhost:${PORT}/drone`);
    if (ips.length && httpsOk) {
      console.log('  ---------------------------------------------');
      console.log('  ON YOUR PHONE (same Wi-Fi) — use HTTPS for the camera:');
      for (const ip of ips) console.log(`    Drone app  : https://${ip}:${HTTPS_PORT}/drone`);
      console.log('    (accept the "not secure / self-signed certificate" warning once)');
      console.log('  ---------------------------------------------');
      console.log('  Watch the portal on your phone too, if you like:');
      for (const ip of ips) console.log(`    Portal     : https://${ip}:${HTTPS_PORT}/`);
    }
    console.log('');
  });
}

start();
