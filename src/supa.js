// Supabase adapter: Postgres persistence + image Storage.
// Enabled only when SUPABASE_URL + SUPABASE_SECRET_KEY are set; otherwise the
// app falls back to the local JSON store (see db.js).

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
export const SUPA_ENABLED = !!(URL && KEY);
export const BUCKET = 'drone-images';

let sb = null;
if (SUPA_ENABLED) sb = createClient(URL, KEY, { auth: { persistSession: false } });

// The app uses camelCase; the DB columns are snake_case. We only convert the
// TOP-LEVEL keys (column names) — nested jsonb values keep their camelCase.
const camelToSnake = (k) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const snakeToCamel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const toRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [camelToSnake(k), v === undefined ? null : v]));
const fromRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [snakeToCamel(k), v]));

// [in-memory collection name, DB table name]
const COLLECTIONS = [
  ['drones', 'drones'],
  ['alerts', 'alerts'],
  ['dispatches', 'dispatches'],
  ['mainForce', 'main_force']
];

// Per-collection map of id -> serialized row we last synced. Seeded from loadAll().
// Lets us upsert ONLY rows that actually changed (a single GPS ping used to re-upsert
// EVERY drone/alert/dispatch/mainForce row) and delete ONLY rows removed from state.
const lastSynced = { drones: new Map(), alerts: new Map(), dispatches: new Map(), mainForce: new Map() };

// Stable serialization: sort TOP-LEVEL keys so column order never causes a false diff.
// (Do NOT use JSON.stringify's array-replacer — it would recursively strip nested keys.)
function rowKey(row) {
  const sorted = {};
  for (const k of Object.keys(row).sort()) sorted[k] = row[k];
  return JSON.stringify(sorted);
}

export async function loadAll() {
  const out = { drones: [], alerts: [], dispatches: [], mainForce: [] };
  for (const [coll, table] of COLLECTIONS) {
    const { data, error } = await sb.from(table).select('*').limit(10000);
    if (error) throw new Error(`load ${table}: ${error.message}`);
    out[coll] = (data || []).map(fromRow);
    lastSynced[coll] = new Map(out[coll].map((r) => [r.id, rowKey(toRow(r))]));
  }
  return out;
}

async function deleteIds(table, ids) {
  // Chunk so the id list never overflows the request URL length limit.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { error } = await sb.from(table).delete().in('id', chunk);
    if (error) throw new Error(`delete ${table}: ${error.message}`);
  }
}

async function syncTable(coll, table, records) {
  const seen = new Set();
  const changed = [];
  for (const r of records) {
    seen.add(r.id);
    const row = toRow(r);
    const key = rowKey(row);
    if (lastSynced[coll].get(r.id) !== key) changed.push({ id: r.id, row, key });
  }
  if (changed.length) {
    const { error } = await sb.from(table).upsert(changed.map((c) => c.row));
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
    // Record as synced ONLY after a successful upsert, so a failure retries next time.
    for (const c of changed) lastSynced[coll].set(c.id, c.key);
  }
  // Delete ONLY rows that were actually removed from state.
  const removed = [...lastSynced[coll].keys()].filter((id) => !seen.has(id));
  if (removed.length) {
    await deleteIds(table, removed);
    for (const id of removed) lastSynced[coll].delete(id);
  }
}

export async function syncAll(state) {
  // Isolate tables: one table's failure must not block the others.
  const errors = [];
  for (const [coll, table] of COLLECTIONS) {
    try {
      await syncTable(coll, table, state[coll] || []);
    } catch (err) {
      errors.push(err.message);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export async function ensureBucket() {
  const { data, error } = await sb.storage.listBuckets();
  if (error) {
    console.warn('[supa] listBuckets:', error.message);
    return;
  }
  if (!data.find((b) => b.name === BUCKET)) {
    const { error: cErr } = await sb.storage.createBucket(BUCKET, { public: true });
    if (cErr && !/already exists/i.test(cErr.message)) console.warn('[supa] createBucket:', cErr.message);
  }
}

export async function uploadImage(buffer, name) {
  const { error } = await sb.storage.from(BUCKET).upload(name, buffer, {
    contentType: 'image/jpeg',
    upsert: true
  });
  if (error) throw new Error('upload: ' + error.message);
  return sb.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
}

// Delete specific images (by object name) from the Storage bucket. Best-effort.
export async function deleteImages(names) {
  if (names && names.length) await sb.storage.from(BUCKET).remove(names);
}

// Delete every captured image from the Storage bucket. Returns the count removed.
export async function clearImages() {
  const { data, error } = await sb.storage.from(BUCKET).list('', { limit: 10000 });
  if (error) throw new Error('list images: ' + error.message);
  const names = (data || []).filter((o) => o.name).map((o) => o.name);
  if (names.length) {
    const { error: rmErr } = await sb.storage.from(BUCKET).remove(names);
    if (rmErr) throw new Error('remove images: ' + rmErr.message);
  }
  return names.length;
}
