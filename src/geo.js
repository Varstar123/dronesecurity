// Small geo helpers. Coordinates are plain {lat, lng} in degrees.

const R = 6371; // Earth radius in km

export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Return drones sorted by distance to `target`, annotated with distanceKm.
// Only ONLINE drones (a real phone is controlling them) can be dispatched.
// Returns them ranked by distance to the target. If any are within `radiusKm`
// we return those (up to 4); otherwise the nearest online drones respond
// regardless of distance — because they're the only ones that actually can.
export function findNearbyDrones(target, drones, { radiusKm = 3, minCount = 3 } = {}) {
  const ranked = drones
    .filter((d) => d.connected && d.status !== 'dispatched' && !d.activeDispatchId && typeof d.lat === 'number')
    .map((d) => ({ ...d, distanceKm: haversineKm(target, { lat: d.lat, lng: d.lng }) }))
    .sort((x, y) => x.distanceKm - y.distanceKm);

  const within = ranked.filter((d) => d.distanceKm <= radiusKm);
  if (within.length >= 1) return within.slice(0, Math.max(minCount, within.length > 4 ? 4 : within.length));
  return ranked.slice(0, minCount);
}
