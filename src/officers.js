// Officer account store. Uses Supabase when configured; otherwise a local JSON file
// (data/officers.json) so the app still works for local dev without Supabase.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as supa from './supa.js';
import { hashPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '..', 'data', 'officers.json');
const SUPA = supa.SUPA_ENABLED;

export function newId() {
  return `off_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function loadJson() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function saveJson(list) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch (e) { console.error('[officers] save failed:', e.message); }
}

export async function listOfficers() {
  if (SUPA) return supa.officersList();
  return loadJson();
}
export async function findByUsername(u) {
  if (SUPA) return supa.officerByUsername(u);
  return loadJson().find((o) => (o.username || '').toLowerCase() === String(u).toLowerCase()) || null;
}
export async function findById(id) {
  if (SUPA) return supa.officerById(id);
  return loadJson().find((o) => o.id === id) || null;
}
export async function createOfficer(o) {
  if (SUPA) return supa.officerCreate(o);
  const list = loadJson(); list.push(o); saveJson(list); return o;
}
export async function updateOfficer(id, patch) {
  if (SUPA) return supa.officerUpdate(id, patch);
  const list = loadJson();
  const i = list.findIndex((o) => o.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch }; saveJson(list); return list[i];
}
export async function removeOfficer(id) {
  if (SUPA) return supa.officerRemove(id);
  saveJson(loadJson().filter((o) => o.id !== id)); return true;
}

// Public-safe view (never leak the password hash).
export function publicOfficer(o) {
  if (!o) return null;
  const { passwordHash, ...rest } = o;
  return rest;
}

// On boot: if there are no admins yet, create a default one so someone can log in.
export async function seedDefaultAdmin() {
  const list = await listOfficers();
  if (list.some((o) => o.role === 'admin')) return;
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  if (!process.env.ADMIN_PASSWORD)
    console.warn('[officers] No admin found — seeding default admin (username: "admin", password: "admin123"). Set ADMIN_PASSWORD and change it after first login.');
  await createOfficer({
    id: newId(), username: 'admin', passwordHash: await hashPassword(pw),
    name: 'System Administrator', badgeId: 'ADMIN-001', station: 'Control HQ',
    photo: null, role: 'admin', active: true, createdAt: new Date().toISOString()
  });
}
