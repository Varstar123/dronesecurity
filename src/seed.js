// Seed a fleet of surveillance drones spread across city sectors.
// Coordinates are around Kozhikode (Calicut), Kerala — home of GEC Kozhikode.
import { db } from './db.js';

const CITY_CENTER = { lat: 11.2588, lng: 75.7804 };

// 4 drones — one per group phone, spread across the city.
const FLEET = [
  { name: 'Drone 1', sector: 'Sector 1 - Mananchira', lat: 11.251, lng: 75.775 },
  { name: 'Drone 2', sector: 'Sector 2 - SM Street',  lat: 11.247, lng: 75.781 },
  { name: 'Drone 3', sector: 'Sector 3 - Nadakkavu',  lat: 11.272, lng: 75.777 },
  { name: 'Drone 4', sector: 'Sector 4 - Kallai',     lat: 11.238, lng: 75.789 }
];

export function seedFleet() {
  const wanted = FLEET.map((f, i) => ({ id: `drone-${i + 1}`, ...f }));
  const wantedIds = new Set(wanted.map((w) => w.id));
  const existing = db.drones();

  // Reconcile the fleet to match FLEET: keep known drones (resetting transient
  // state), add any missing, and drop any extras (e.g. after shrinking 8 → 4).
  const kept = existing.filter((d) => wantedIds.has(d.id));
  for (const w of wanted) {
    let d = kept.find((x) => x.id === w.id);
    if (!d) {
      kept.push({
        id: w.id,
        name: w.name,
        sector: w.sector,
        lat: w.lat,
        lng: w.lng,
        status: 'monitoring', // monitoring | alerting | dispatched | offline
        battery: 70 + Math.floor(Math.random() * 30),
        connected: false, // true when a phone camera is live-controlling this drone
        liveView: false, // true when police have an on-demand live view open
        activeDispatchId: null,
        lastSeen: null
      });
    } else {
      d.name = w.name;
      d.sector = w.sector;
      d.connected = false;
      d.liveView = false;
      if (d.status === 'dispatched' || d.status === 'alerting') d.status = 'monitoring';
      d.activeDispatchId = null;
    }
  }
  // Close out any dispatch left "active" from before the restart.
  for (const disp of db.dispatches()) {
    if (disp.status === 'active') {
      disp.status = 'resolved';
      disp.resolvedAt = new Date().toISOString();
    }
  }
  db.setDrones(kept);
  console.log(`[seed] fleet reconciled to ${kept.length} drones around Kozhikode`);
}

// Named places police can dispatch drones to by name (no map/coords needed).
// Approximate coordinates around Kozhikode — good enough for the demo.
// Home (base) position of each drone, so a simulated drone can return after a
// dispatch. Keyed by drone id (drone-1 … drone-N).
export const HOME_POSITIONS = Object.fromEntries(FLEET.map((f, i) => [`drone-${i + 1}`, { lat: f.lat, lng: f.lng }]));

export const LANDMARKS = [
  { name: 'Jewellery Market, Big Bazaar', lat: 11.2486, lng: 75.7793 },
  { name: 'SM Street (Mittai Theruvu)', lat: 11.2470, lng: 75.781 },
  { name: 'SBI Main Branch', lat: 11.2502, lng: 75.7788 },
  { name: 'Focus Mall', lat: 11.254, lng: 75.783 },
  { name: 'Mananchira Square', lat: 11.251, lng: 75.775 },
  { name: 'Railway Station', lat: 11.2478, lng: 75.7746 },
  { name: 'Palayam Market', lat: 11.262, lng: 75.782 },
  { name: 'Calicut Beach', lat: 11.256, lng: 75.769 },
  { name: 'Medical College', lat: 11.279, lng: 75.801 },
  { name: 'Nadakkavu', lat: 11.272, lng: 75.777 }
];

export { CITY_CENTER };
