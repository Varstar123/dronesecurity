// Persistence layer.
// Keeps everything in memory (so the rest of the app stays synchronous) and
// mirrors every change to a durable backend:
//   - Supabase Postgres, when SUPABASE_URL + SUPABASE_SECRET_KEY are set, or
//   - a local data/store.json file otherwise.
// The JSON file is always written too, as an offline backup.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as supa from './supa.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const EMPTY = { drones: [], alerts: [], dispatches: [], mainForce: [] };

let state = structuredClone(EMPTY);
let flushTimer = null;

function loadJson() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      state = { ...structuredClone(EMPTY), ...raw };
    }
  } catch (err) {
    console.warn('[db] could not read store.json, starting fresh:', err.message);
    state = structuredClone(EMPTY);
  }
}

// ---- Supabase sync (async, non-blocking, coalesced) ----------------------
let syncing = false;
let dirty = false;
function queueSupabaseSync() {
  if (syncing) {
    dirty = true;
    return;
  }
  syncing = true;
  supa
    .syncAll(state)
    .catch((err) => console.warn('[db] Supabase sync failed:', err.message))
    .finally(() => {
      syncing = false;
      if (dirty) {
        dirty = false;
        queueSupabaseSync();
      }
    });
}

// Async, serialized JSON write so a large state doesn't block the event loop and
// two overlapping writes never interleave and corrupt the file.
let writing = false;
let writeAgain = false;
async function writeJson() {
  if (writing) {
    writeAgain = true;
    return;
  }
  writing = true;
  try {
    await fs.promises.writeFile(STORE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[db] failed to persist store:', err.message);
  } finally {
    writing = false;
    if (writeAgain) {
      writeAgain = false;
      writeJson();
    }
  }
}

// Debounced write so a burst of updates doesn't hammer the disk / network.
function persist() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeJson();
    if (supa.SUPA_ENABLED) queueSupabaseSync();
  }, 300);
}

// Write JSON immediately (used on shutdown so a pending write isn't lost).
function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    /* best effort on exit */
  }
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  flushSync(); // local JSON immediately — guaranteed even if Supabase is slow/down
  if (supa.SUPA_ENABLED) {
    // Flush the latest state to Supabase before exiting so a Render restart doesn't
    // lose the last ~300ms of debounced changes. Bounded so we never hang shutdown.
    try {
      await Promise.race([
        supa.syncAll(state),
        new Promise((_, reject) => setTimeout(() => reject(new Error('flush timeout')), 4000))
      ]);
    } catch (err) {
      console.warn('[db] final Supabase flush failed:', err.message);
    }
  }
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
process.on('exit', flushSync);

export const db = {
  get state() {
    return state;
  },
  drones: () => state.drones,
  alerts: () => state.alerts,
  dispatches: () => state.dispatches,
  mainForce: () => state.mainForce,

  find(collection, id) {
    return state[collection].find((x) => x.id === id);
  },

  save() {
    persist();
  },

  flush() {
    flushSync();
  },

  setDrones(list) {
    state.drones = list;
    persist();
  },

  reset() {
    state = structuredClone(EMPTY);
    persist();
  },

  // Load initial state. Prefers Supabase; falls back to the local JSON file.
  async init() {
    ensureDirs();
    if (supa.SUPA_ENABLED) {
      try {
        await supa.ensureBucket();
        const loaded = await supa.loadAll();
        state = { ...structuredClone(EMPTY), ...loaded };
        console.log(
          `[db] loaded from Supabase: ${state.drones.length} drones, ${state.alerts.length} alerts, ${state.dispatches.length} dispatches`
        );
        return;
      } catch (err) {
        console.warn('[db] Supabase load failed, using local JSON:', err.message);
      }
    }
    loadJson();
  }
};
