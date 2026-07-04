// Seed a fleet of surveillance drones spread across city sectors.
// Coordinates are around Kozhikode (Calicut), Kerala — home of GEC Kozhikode.
import { db } from './db.js';

const CITY_CENTER = { lat: 11.2588, lng: 75.7804 };

const FLEET = [
  { name: 'Drone 1', sector: 'Sector 1 - Mananchira',   lat: 11.2510, lng: 75.7750 },
  { name: 'Drone 2', sector: 'Sector 2 - SM Street',    lat: 11.2470, lng: 75.7810 },
  { name: 'Drone 3', sector: 'Sector 3 - Beach Road',   lat: 11.2560, lng: 75.7690 },
  { name: 'Drone 4', sector: 'Sector 4 - Palayam',      lat: 11.2620, lng: 75.7820 },
  { name: 'Drone 5', sector: 'Sector 5 - Medical Coll', lat: 11.2790, lng: 75.8010 },
  { name: 'Drone 6', sector: 'Sector 6 - Nadakkavu',    lat: 11.2720, lng: 75.7770 },
  { name: 'Drone 7', sector: 'Sector 7 - Kallai',       lat: 11.2380, lng: 75.7890 },
  { name: 'Drone 8', sector: 'Sector 8 - Vellayil',     lat: 11.2660, lng: 75.7640 }
];

export function seedFleet() {
  if (db.drones().length > 0) {
    // Fleet already exists — just make sure nobody is stuck in a stale state.
    for (const d of db.drones()) {
      d.connected = false;
      d.liveView = false;
      if (d.status === 'dispatched' || d.status === 'alerting') d.status = 'monitoring';
      d.activeDispatchId = null;
    }
    // Close out any dispatch left "active" from before the restart so drones
    // and dispatches don't disagree.
    for (const disp of db.dispatches()) {
      if (disp.status === 'active') {
        disp.status = 'resolved';
        disp.resolvedAt = new Date().toISOString();
      }
    }
    db.save();
    return;
  }

  const drones = FLEET.map((f, i) => ({
    id: `drone-${i + 1}`,
    name: f.name,
    sector: f.sector,
    lat: f.lat,
    lng: f.lng,
    status: 'monitoring', // monitoring | alerting | dispatched | offline
    battery: 70 + Math.floor(Math.random() * 30),
    connected: false, // true when a phone camera is live-controlling this drone
    liveView: false, // true when police have an on-demand live view open
    activeDispatchId: null,
    lastSeen: null
  }));

  db.setDrones(drones);
  console.log(`[seed] created fleet of ${drones.length} drones around Kozhikode`);
}

// Named places police can dispatch drones to by name (no map/coords needed).
// Approximate coordinates around Kozhikode — good enough for the demo.
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
