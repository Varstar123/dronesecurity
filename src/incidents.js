// Catalogue of incident types the drone AI can report.
// `policeRelevant` = the kind of situation where drone security can help and a
// human officer should review it. `normal` means "all clear, keep monitoring".
// `icon` = emoji (used in <option> menus which can't hold SVG);
// `lucide` = Lucide icon name (premium line icon used everywhere else).

export const INCIDENT_TYPES = {
  normal: {
    label: 'Normal / All Clear', icon: '✅', lucide: 'shield-check',
    color: '#16a34a', defaultSeverity: 'none', policeRelevant: false,
    hint: 'Ordinary street/area with no incident.'
  },
  building_fire: {
    label: 'Building on Fire', icon: '🔥', lucide: 'flame',
    color: '#dc2626', defaultSeverity: 'critical', policeRelevant: true,
    hint: 'Smoke or flames coming from a building.'
  },
  forest_fire: {
    label: 'Forest / Wildfire', icon: '🌲', lucide: 'trees',
    color: '#ea580c', defaultSeverity: 'critical', policeRelevant: true,
    hint: 'Fire or heavy smoke over vegetation / trees.'
  },
  traffic_block: {
    label: 'Traffic Block', icon: '🚗', lucide: 'car-front',
    color: '#d97706', defaultSeverity: 'medium', policeRelevant: true,
    hint: 'Long standstill of vehicles / congestion.'
  },
  road_accident: {
    label: 'Road Accident', icon: '🚑', lucide: 'ambulance',
    color: '#e11d48', defaultSeverity: 'high', policeRelevant: true,
    hint: 'Collision, overturned vehicle, people hurt on road.'
  },
  person_alone_at_night: {
    label: 'Person Alone in the Dark', icon: '🌙', lucide: 'moon',
    color: '#7c3aed', defaultSeverity: 'medium', policeRelevant: true,
    hint: 'A lone individual walking in a dark / isolated area.'
  },
  crowd_gathering: {
    label: 'Unusual Crowd', icon: '👥', lucide: 'users',
    color: '#0891b2', defaultSeverity: 'medium', policeRelevant: true,
    hint: 'A large or unusual gathering of people.'
  },
  flood: {
    label: 'Flooding / Water Logging', icon: '🌊', lucide: 'waves',
    color: '#2563eb', defaultSeverity: 'high', policeRelevant: true,
    hint: 'Roads or area submerged in water.'
  },
  suspicious_activity: {
    label: 'Suspicious Activity', icon: '⚠️', lucide: 'eye',
    color: '#be123c', defaultSeverity: 'high', policeRelevant: true,
    hint: 'Break-in, vandalism, trespassing, or other suspicious behaviour.'
  },
  weapon_threat: {
    label: 'Armed Person / Weapon', icon: '🔫', lucide: 'crosshair',
    color: '#b91c1c', defaultSeverity: 'critical', policeRelevant: true,
    hint: 'A person visibly carrying or brandishing a weapon (gun, knife, etc.).'
  },
  violence_assault: {
    label: 'Violence / Assault', icon: '🥊', lucide: 'swords',
    color: '#9f1239', defaultSeverity: 'high', policeRelevant: true,
    hint: 'A physical fight, attack, or someone being assaulted.'
  },
  theft_robbery: {
    label: 'Theft / Robbery', icon: '🦹', lucide: 'user-x',
    color: '#a21caf', defaultSeverity: 'high', policeRelevant: true,
    hint: 'A robbery, snatching, or theft in progress.'
  },
  medical_emergency: {
    label: 'Medical Emergency', icon: '🩺', lucide: 'heart-pulse',
    color: '#db2777', defaultSeverity: 'high', policeRelevant: true,
    hint: 'A person collapsed, unconscious, or lying motionless on the ground.'
  },
  abandoned_object: {
    label: 'Unattended Object', icon: '🧳', lucide: 'briefcase',
    color: '#a16207', defaultSeverity: 'high', policeRelevant: true,
    hint: 'An unattended bag, package, or suspicious object left in a public place.'
  },
  stampede: {
    label: 'Stampede / Crowd Panic', icon: '😱', lucide: 'footprints',
    color: '#c2410c', defaultSeverity: 'critical', policeRelevant: true,
    hint: 'A dangerous crowd surge, crush, or people fleeing in panic.'
  },
  building_collapse: {
    label: 'Building Collapse', icon: '🏚️', lucide: 'building-2',
    color: '#78350f', defaultSeverity: 'critical', policeRelevant: true,
    hint: 'A collapsed or severely damaged structure with debris.'
  },
  animal_intrusion: {
    label: 'Animal Intrusion', icon: '🐘', lucide: 'paw-print',
    color: '#4d7c0f', defaultSeverity: 'medium', policeRelevant: true,
    hint: 'A wild or stray animal (elephant, cattle, dogs) straying into a populated area.'
  },
  electrical_hazard: {
    label: 'Electrical Hazard', icon: '⚡', lucide: 'zap',
    color: '#ca8a04', defaultSeverity: 'high', policeRelevant: true,
    hint: 'A downed or sparking power line, or a transformer fire.'
  }
};

export const INCIDENT_KEYS = Object.keys(INCIDENT_TYPES);

export const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function meta(type) {
  return INCIDENT_TYPES[type] || INCIDENT_TYPES.normal;
}
