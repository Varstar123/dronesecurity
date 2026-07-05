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
import compression from 'compression';
import { Server as SocketServer } from 'socket.io';

import { db, UPLOAD_DIR } from './src/db.js';
import * as supa from './src/supa.js';
import { seedFleet, CITY_CENTER, LANDMARKS } from './src/seed.js';
import { analyzeFrame, AI_MODE, AI_LABEL } from './src/ai.js';
import { findNearbyDrones, haversineKm } from './src/geo.js';
import { INCIDENT_TYPES, meta } from './src/incidents.js';
import {
  hashPassword, verifyPassword, setSession, clearSession, sessionFromReq,
  requireAuth, requireAdmin, requireAuthPage, requireAdminPage
} from './src/auth.js';
import {
  listOfficers, findByUsername, findById, createOfficer, updateOfficer,
  removeOfficer, publicOfficer, seedDefaultAdmin, newId
} from './src/officers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || PORT + 443; // 3443 by default
const MAX_FRAMES_PER_DISPATCH = 16;
const MAX_UPDATES_PER_DISPATCH = 50; // field updates kept per dispatch
const MAX_MAINFORCE = 500; // main-force log records kept in memory / DB
const MAX_ALERTS = 300; // alert records kept (pending always retained; oldest reviewed evicted)
// Police authorization key required to clear captured images (change via .env).
const CLEAR_SECRET = process.env.CLEAR_SECRET || 'police2026';
// A drone counts as "reached the location" within this distance of the target.
const ARRIVAL_RADIUS_KM = 0.02; // 20 metres

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  maxHttpBufferSize: 12e6,
  // Detect a phone that vanished (killed app / lost signal) faster than the ~45s
  // default, so it stops looking online and dispatchable.
  pingInterval: 10000,
  pingTimeout: 12000
});

// Last-resort safety net: a single malformed socket payload or a rejected async
// operation must never take the whole control-center process down. Log and stay up.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err && err.stack ? err.stack : err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err && err.stack ? err.stack : err));

app.use(compression()); // gzip every response — must precede routes & static
app.use(express.json({ limit: '15mb' }));

// ---- page routes (defined BEFORE static so login-gating can't be bypassed) ----
const page = (f) => path.join(__dirname, 'public', f);
app.get('/login', (_req, res) => res.sendFile(page('login.html')));
app.get(['/', '/index.html'], requireAuthPage, (_req, res) => res.sendFile(page('index.html')));
app.get(['/admin', '/admin.html'], requireAdminPage, (_req, res) => res.sendFile(page('admin.html')));
app.get('/drone', (_req, res) => res.sendFile(page('drone.html'))); // drone app stays open (field device)

// static assets (css/js/images) — index:false so it never serves index.html at "/"
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', immutable: true }));

// ---- auth API -----------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  let o;
  try {
    o = await findByUsername(username);
  } catch (e) {
    return res.status(500).json({ error: 'Login unavailable — is the officers table created? ' + e.message });
  }
  if (!o || o.active === false || !(await verifyPassword(password, o.passwordHash)))
    return res.status(401).json({ error: 'Invalid username or password' });
  setSession(res, { id: o.id, role: o.role, username: o.username });
  res.json(publicOfficer(o));
});
app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });
app.get('/api/auth/me', async (req, res) => {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'not authenticated' });
  let o = null;
  try { o = await findById(s.id); } catch { /* table may be missing */ }
  if (!o || o.active === false) { clearSession(res); return res.status(401).json({ error: 'not authenticated' }); }
  res.json(publicOfficer(o));
});
// A logged-in officer updates their OWN profile photo (small avatar data URI).
app.post('/api/auth/photo', requireAuth, async (req, res) => {
  const { photo } = req.body || {};
  if (typeof photo !== 'string' || !photo.startsWith('data:image/'))
    return res.status(400).json({ error: 'a valid image is required' });
  if (photo.length > 800000) return res.status(413).json({ error: 'image too large — please pick a smaller one' });
  try {
    const o = await updateOfficer(req.session.id, { photo });
    if (!o) return res.status(404).json({ error: 'officer not found' });
    res.json(publicOfficer(o));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API access guard: everything under /api requires a login EXCEPT the shared
// endpoints the (unauthenticated) drone app needs, and the auth endpoints themselves.
const OPEN_API = new Set(['/api/config', '/api/drones', '/api/analyze']);
const OPEN_API_RE = [/^\/api\/drones\/[^/]+\/live\/frame$/, /^\/api\/dispatches\/[^/]+\/frame$/];
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/auth/')) return next();
  if (OPEN_API.has(req.path) || OPEN_API_RE.some((re) => re.test(req.path))) return next();
  return requireAuth(req, res, next);
});

// ---- officers (admin module) --------------------------------------------
app.get('/api/officers', requireAdmin, async (_req, res) => {
  try { res.json((await listOfficers()).map(publicOfficer)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/officers', requireAdmin, async (req, res) => {
  const { username, password, name, badgeId, station, photo, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    if (await findByUsername(username)) return res.status(409).json({ error: 'That username already exists' });
    const o = {
      id: newId(), username: String(username).trim(), passwordHash: await hashPassword(password),
      name: name || username, badgeId: badgeId || '', station: station || '', photo: photo || null,
      role: role === 'admin' ? 'admin' : 'officer', active: true, createdAt: new Date().toISOString()
    };
    await createOfficer(o);
    res.json(publicOfficer(o));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/api/officers/:id', requireAdmin, async (req, res) => {
  const { name, badgeId, station, photo, role, active, password } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (badgeId !== undefined) patch.badgeId = badgeId;
  if (station !== undefined) patch.station = station;
  if (photo !== undefined) patch.photo = photo;
  if (role !== undefined) patch.role = role === 'admin' ? 'admin' : 'officer';
  if (active !== undefined) patch.active = !!active;
  if (password) patch.passwordHash = await hashPassword(password);
  if (req.params.id === req.session.id && (patch.role === 'officer' || patch.active === false))
    return res.status(400).json({ error: "You can't demote or deactivate your own account." });
  try {
    const o = await updateOfficer(req.params.id, patch);
    if (!o) return res.status(404).json({ error: 'officer not found' });
    res.json(publicOfficer(o));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/officers/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.session.id) return res.status(400).json({ error: "You can't delete your own account." });
  try {
    const list = await listOfficers();
    const target = list.find((o) => o.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'officer not found' });
    if (target.role === 'admin' && list.filter((o) => o.role === 'admin' && o.active !== false).length <= 1)
      return res.status(400).json({ error: 'Cannot delete the last active admin.' });
    await removeOfficer(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
async function storeBuffer(buffer) {
  if (!buffer || !buffer.length) return null;
  const name = `${uid('img')}.jpg`;
  if (supa.SUPA_ENABLED) {
    // Try the shared object store (with one retry). Do NOT fall back to a local
    // file — that path is stored in the shared DB and would 404 on every other
    // instance (and on the next Render restart). Better to store no image.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await supa.uploadImage(buffer, name);
      } catch (err) {
        if (attempt === 1) {
          console.warn('[img] Storage upload failed after retry, storing no image:', err.message);
          return null;
        }
      }
    }
  }
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buffer); // async: don't block the event loop
  return `/uploads/${name}`;
}
async function saveImage(dataUrl) {
  const b64 = stripBase64(dataUrl);
  if (!b64) return null;
  return storeBuffer(Buffer.from(b64, 'base64'));
}
// Archive a raw binary frame (from the WebSocket live/dispatch streams).
async function saveImageBuffer(buffer) {
  return storeBuffer(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []));
}

// Delete stored images given their URLs (Supabase public URL or /uploads/ path).
// Best-effort, fire-and-forget — used to reclaim evicted dispatch frames.
async function deleteImagesByUrl(urls) {
  const names = (urls || []).filter(Boolean).map((u) => String(u).split('/').pop());
  if (!names.length) return;
  try {
    if (supa.SUPA_ENABLED) await supa.deleteImages(names);
    else for (const n of names) await fs.promises.unlink(path.join(UPLOAD_DIR, n)).catch(() => {});
  } catch { /* best effort */ }
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
  // Only emit dispatch:arrived — the portal's handler already refetches/re-renders,
  // so a second dispatch:updated here would just double the work per arrival.
  toPolice('dispatch:arrived', { dispatchId: dispatch.id, ...rec });
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
    } else {
      const imageUrl = await saveImage(image);
      // Re-validate AFTER the awaits (analyzeFrame + saveImage): during that window the
      // drone may have been committed to a dispatch, or a concurrent scan may already have
      // raised an alert for it. Never demote a dispatched drone or inject a stale alert.
      if (drone.activeDispatchId || drone.status === 'dispatched') {
        alert = null; // drone is now en route to a dispatch — suppress this alert.
      } else {
        const dup = db.alerts().find((a) => a.droneId === drone.id && a.status === 'pending_review');
        if (dup) {
          alert = dup;
        } else {
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
          // Cap total alerts (like mainForce/frames). Never drop a pending alert —
          // it's still referenced by escalate/dismiss + dedup; evict oldest reviewed.
          if (db.alerts().length > MAX_ALERTS) {
            const pending = db.alerts().filter((a) => a.status === 'pending_review');
            const keep = Math.max(0, MAX_ALERTS - pending.length);
            const reviewed = db.alerts().filter((a) => a.status !== 'pending_review').slice(-keep);
            db.state.alerts = [...reviewed, ...pending];
          }
          drone.status = 'alerting';
          db.save();
          toPolice('alert:new', alert);
        }
      }
    }
  }

  // Always push live telemetry (position + online) so the map stays current, even when no
  // new alert was raised (normal scan, duplicate, or suppressed-during-dispatch).
  droneStatus(drone);
  pushStats();

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
  if (db.mainForce().length > MAX_MAINFORCE)
    db.state.mainForce = db.mainForce().slice(-MAX_MAINFORCE);

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
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return res.status(400).json({ error: 'valid lat/lng required' });

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

const frameSaveCounter = new Map(); // dispatchId -> count, for the 1-in-N archival throttle
const FRAME_SAVE_EVERY = 4; // archive every 4th frame (the live view is inline, this is history)

app.post('/api/dispatches/:id/frame', (req, res) => {
  const dispatch = db.find('dispatches', req.params.id);
  if (!dispatch) return res.status(404).json({ error: 'unknown dispatch' });
  if (dispatch.status !== 'active') return res.status(409).json({ error: 'dispatch not active' });

  const { droneId, image } = req.body || {};
  const drone = db.find('drones', droneId);
  if (!drone) return res.status(404).json({ error: 'unknown drone' });
  if (!stripBase64(image)) return res.status(400).json({ error: 'no image' });

  const at = new Date().toISOString();
  // Relay the frame INLINE for immediate display. This keeps Supabase Storage off the
  // critical path — previously we uploaded the JPEG AND every portal re-downloaded it,
  // stacking ~2 network round-trips per frame on top of the interval (the "laggy footage").
  toPolice('dispatch:frame', { dispatchId: dispatch.id, droneId: drone.id, droneName: drone.name, at, image });
  res.json({ ok: true });

  // Archive a thumbnail occasionally (1-in-N) for late-join / reload — fire-and-forget,
  // URL only (never the base64 image, which would bloat every Supabase/JSON sync).
  const n = (frameSaveCounter.get(dispatch.id) || 0) + 1;
  frameSaveCounter.set(dispatch.id, n);
  if (n % FRAME_SAVE_EVERY !== 1) return; // save the 1st, 5th, 9th… frame only
  saveImage(image)
    .then((url) => {
      if (!url) return;
      const d = db.find('dispatches', dispatch.id);
      if (!d || d.status !== 'active') return;
      d.frames.push({ id: uid('frame'), droneId: drone.id, droneName: drone.name, url, at });
      if (d.frames.length > MAX_FRAMES_PER_DISPATCH) {
        const evicted = d.frames.slice(0, d.frames.length - MAX_FRAMES_PER_DISPATCH);
        d.frames = d.frames.slice(-MAX_FRAMES_PER_DISPATCH);
        deleteImagesByUrl(evicted.map((f) => f.url)); // reclaim evicted Storage objects
      }
      db.save();
    })
    .catch(() => {});
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
  if (dispatch.updates.length > MAX_UPDATES_PER_DISPATCH)
    dispatch.updates = dispatch.updates.slice(-MAX_UPDATES_PER_DISPATCH);

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
  if (db.mainForce().length > MAX_MAINFORCE)
    db.state.mainForce = db.mainForce().slice(-MAX_MAINFORCE);
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
  frameSaveCounter.delete(dispatch.id); // stop tracking archival throttle for this dispatch

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

// ---- clear resolved dispatches (tidy up the pile) -----------------------

app.post('/api/dispatches/clear-resolved', (_req, res) => {
  const before = db.dispatches().length;
  db.state.dispatches = db.dispatches().filter((d) => d.status === 'active');
  db.save();
  toPolice('refresh', {});
  pushStats();
  res.json({ ok: true, cleared: before - db.dispatches().length });
});

// Clear reviewed incident alerts (keeps the pending queue).
app.post('/api/alerts/clear-reviewed', (_req, res) => {
  const before = db.alerts().length;
  db.state.alerts = db.alerts().filter((a) => a.status === 'pending_review');
  db.save();
  toPolice('refresh', {});
  pushStats();
  res.json({ ok: true, cleared: before - db.alerts().length });
});

// ---- resolve coordinates from a shared map/location link ----------------

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
function coordsFromString(s) {
  for (const re of MAP_COORD_PATTERNS) {
    const m = String(s).match(re);
    if (m) {
      const lat = parseFloat(m[1]);
      const lng = parseFloat(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)
        return { lat, lng };
    }
  }
  return null;
}

const MAP_HOSTS = ['google.com', 'goo.gl', 'g.co', 'openstreetmap.org', 'osm.org', 'apple.com', 'waze.com'];
function isMapHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return MAP_HOSTS.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Read a response body but stop after `maxBytes` so a huge page can't exhaust memory.
async function readCapped(resp, maxBytes) {
  const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) return (await resp.text()).slice(0, maxBytes);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(Buffer.from(value));
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveMapUrl(url) {
  let c = coordsFromString(url);
  if (c) return c;
  if (!isMapHost(url)) return null; // don't fetch arbitrary hosts (SSRF guard)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    let current = url;
    let resp = null;
    // Follow redirects manually so EVERY hop is re-checked against the allowlist —
    // otherwise a short-link could 3xx-redirect us to an internal/arbitrary host (SSRF).
    for (let hop = 0; hop < 5; hop++) {
      if (!isMapHost(current)) return null;
      resp = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartDrone/1.0)' }
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).toString(); // resolve relative redirects
        c = coordsFromString(current);
        if (c) return c;
        continue;
      }
      break;
    }
    if (!resp) return null;
    c = coordsFromString(resp.url || current);
    if (c) return c;
    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    if (ctype && !/text\/html|text\/plain|xhtml|application\/json/.test(ctype)) return null;
    const html = await readCapped(resp, 2 * 1024 * 1024); // 2 MB cap
    return coordsFromString(html);
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/resolve-location', async (req, res) => {
  const url = ((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'not a link' });
  try {
    const c = await resolveMapUrl(url);
    if (!c) return res.status(422).json({ error: 'no coordinates found in that link' });
    res.json(c);
  } catch (err) {
    res.status(502).json({ error: 'could not open the link: ' + err.message });
  }
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

// A drone is "taken" if a socket from a DIFFERENT physical device is in its room.
// The same device reconnecting (its old socket hasn't hit ping-timeout yet) is NOT
// a conflict — otherwise every reconnect would bounce the phone off its own drone.
function droneTakenByOther(droneId, socket) {
  const room = io.sockets.adapter.rooms.get(`drone:${droneId}`);
  if (!room) return false;
  for (const sid of room) {
    if (sid === socket.id) continue;
    const other = io.sockets.sockets.get(sid);
    const otherDevice = other && other.data ? other.data.deviceId : null;
    if (otherDevice && socket.data.deviceId && otherDevice === socket.data.deviceId) continue; // same device
    return true;
  }
  return false;
}

// Police live-view watchers: droneId -> Set of watching police socket ids. Lets us
// stop a drone's stream when the LAST officer watching it goes away (incl. on a
// browser-tab close, where no explicit /live/stop is ever sent).
const liveWatchers = new Map();
function stopLiveIfUnwatched(droneId) {
  const set = liveWatchers.get(droneId);
  if (set && set.size > 0) return; // still being watched
  const drone = db.find('drones', droneId);
  if (drone && drone.liveView) {
    drone.liveView = false;
    db.save();
    toDrone(drone.id, 'drone:command', { type: 'livestream_stop' });
    toPolice('drone:status', drone);
  }
}
// Drone ids that no device is currently controlling.
function availableDroneIds() {
  return db
    .drones()
    .filter((d) => {
      const room = io.sockets.adapter.rooms.get(`drone:${d.id}`);
      return !(room && room.size > 0);
    })
    .map((d) => d.id);
}

io.on('connection', (socket) => {
  socket.on('police:join', () => {
    socket.join('police');
    socket.emit('stats', stats());
  });

  // Portal opened a live camera feed → register this officer as a watcher.
  socket.on('police:watch', (payload) => {
    if (!payload || typeof payload !== 'object' || !payload.droneId) return;
    const { droneId } = payload;
    if (!liveWatchers.has(droneId)) liveWatchers.set(droneId, new Set());
    liveWatchers.get(droneId).add(socket.id);
  });

  // Portal closed a live camera feed → drop this officer; stop if nobody's left.
  socket.on('police:unwatch', (payload) => {
    if (!payload || typeof payload !== 'object' || !payload.droneId) return;
    const { droneId } = payload;
    const set = liveWatchers.get(droneId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) liveWatchers.delete(droneId);
    }
    stopLiveIfUnwatched(droneId);
  });

  socket.on('drone:hello', (payload) => {
    if (!payload || typeof payload !== 'object') return; // guard null/garbage payloads
    const { droneId, deviceId } = payload;
    const drone = db.find('drones', droneId);
    if (!drone) return;
    if (deviceId) socket.data.deviceId = String(deviceId); // stable per-device id (survives reconnects)
    // One device per drone: reject only if a DIFFERENT device already controls this one.
    if (droneTakenByOther(droneId, socket)) {
      socket.emit('drone:taken', { droneId, available: availableDroneIds() });
      return;
    }
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
    socket.join('drones'); // receive fleet-change notifications
    drone.connected = true;
    drone.lastSeen = new Date().toISOString();
    db.save();
    toPolice('drone:status', drone);
    pushStats();
    io.to('drones').emit('fleet:changed'); // refresh other drone apps' dropdowns
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
  socket.on('drone:location', (payload) => {
    if (!payload || typeof payload !== 'object') return; // guard null/garbage payloads
    const { droneId, lat, lng, battery } = payload;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
    // Ownership: only the device that said hello for this drone may move it.
    if (socket.data.droneId !== droneId) return;
    const drone = db.find('drones', droneId);
    if (!drone) return;
    drone.lat = lat;
    drone.lng = lng;
    if (typeof battery === 'number' && battery >= 0 && battery <= 100) drone.battery = Math.round(battery);
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

  // On-demand live camera over the WebSocket as BINARY (no HTTP + no base64 bloat) —
  // far lower per-frame latency than POSTing frames, so the modal feed is smooth.
  socket.on('drone:liveframe', (droneId, buf, ack) => {
    if (typeof ack === 'function') ack(); // release the drone's backpressure immediately
    if (socket.data.droneId !== droneId) return; // only the controlling device may stream it
    const drone = db.find('drones', droneId);
    if (!drone || !drone.liveView || !buf) return; // nobody watching → drop
    io.to('police').emit('live:frame:bin', { droneId, buf, at: new Date().toISOString() });
  });

  // Dispatch footage over the WebSocket as BINARY too — same smooth path as the live
  // camera. Relay inline for display; archive a thumbnail occasionally (URL only).
  socket.on('drone:dispframe', (dispatchId, droneId, buf, ack) => {
    if (typeof ack === 'function') ack(); // release the drone's send window immediately
    if (socket.data.droneId !== droneId) return; // only the controlling device may stream
    const dispatch = db.find('dispatches', dispatchId);
    const drone = db.find('drones', droneId);
    if (!dispatch || dispatch.status !== 'active' || !drone || !buf) return;
    const at = new Date().toISOString();
    io.to('police').emit('dispatch:frame:bin', { dispatchId, droneId, droneName: drone.name, buf, at });
    // Throttled fire-and-forget archival (1-in-N), URL only, for late-join / reload.
    const n = (frameSaveCounter.get(dispatchId) || 0) + 1;
    frameSaveCounter.set(dispatchId, n);
    if (n % FRAME_SAVE_EVERY !== 1) return;
    saveImageBuffer(buf)
      .then((url) => {
        if (!url) return;
        const d = db.find('dispatches', dispatchId);
        if (!d || d.status !== 'active') return;
        d.frames.push({ id: uid('frame'), droneId, droneName: drone.name, url, at });
        if (d.frames.length > MAX_FRAMES_PER_DISPATCH) {
          const evicted = d.frames.slice(0, d.frames.length - MAX_FRAMES_PER_DISPATCH);
          d.frames = d.frames.slice(-MAX_FRAMES_PER_DISPATCH);
          deleteImagesByUrl(evicted.map((f) => f.url));
        }
        db.save();
      })
      .catch(() => {});
  });

  socket.on('disconnect', () => {
    // Police live-view cleanup: drop this socket from every drone it was watching,
    // and stop any drone whose last watcher just left (tab closed, no /live/stop).
    for (const [dId, set] of liveWatchers) {
      if (set.delete(socket.id) && set.size === 0) {
        liveWatchers.delete(dId);
        stopLiveIfUnwatched(dId);
      }
    }

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
      io.to('drones').emit('fleet:changed'); // this drone is free again
    }
  });
});

// Safety sweep: reconcile "connected" against real socket presence every 10s. If a
// drone is flagged online but no socket is actually in its room (e.g. a disconnect
// event was missed), mark it offline so it stops looking dispatchable. Ground truth
// is room membership, not lastSeen, so an idle-but-live phone is never falsely dropped.
setInterval(() => {
  let changed = false;
  for (const drone of db.drones()) {
    if (!drone.connected) continue;
    const room = io.sockets.adapter.rooms.get(`drone:${drone.id}`);
    if (room && room.size > 0) continue;
    drone.connected = false;
    drone.liveView = false;
    changed = true;
    toPolice('drone:status', drone);
  }
  if (changed) {
    db.save();
    pushStats();
    io.to('drones').emit('fleet:changed');
  }
}, 10000).unref();

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
  try {
    await seedDefaultAdmin(); // ensure at least one admin login exists
  } catch (e) {
    console.warn('[auth] Could not initialise officer accounts (is the `officers` table created in Supabase?):', e.message);
  }

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
