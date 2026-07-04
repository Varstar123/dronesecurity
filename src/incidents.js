// Catalogue of incident types the drone AI can report.
// `policeRelevant` = the kind of situation where drone security can help and a
// human officer should review it. `normal` means "all clear, keep monitoring".

export const INCIDENT_TYPES = {
  normal: {
    label: 'Normal / All Clear',
    icon: '✅',
    color: '#16a34a',
    defaultSeverity: 'none',
    policeRelevant: false,
    hint: 'Ordinary street/area with no incident.'
  },
  building_fire: {
    label: 'Building on Fire',
    icon: '🔥',
    color: '#dc2626',
    defaultSeverity: 'critical',
    policeRelevant: true,
    hint: 'Smoke or flames coming from a building.'
  },
  forest_fire: {
    label: 'Forest / Wildfire',
    icon: '🌲',
    color: '#ea580c',
    defaultSeverity: 'critical',
    policeRelevant: true,
    hint: 'Fire or heavy smoke over vegetation / trees.'
  },
  traffic_block: {
    label: 'Traffic Block',
    icon: '🚗',
    color: '#d97706',
    defaultSeverity: 'medium',
    policeRelevant: true,
    hint: 'Long standstill of vehicles / congestion.'
  },
  road_accident: {
    label: 'Road Accident',
    icon: '🚑',
    color: '#e11d48',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'Collision, overturned vehicle, people hurt on road.'
  },
  person_alone_at_night: {
    label: 'Person Alone in the Dark',
    icon: '🌙',
    color: '#7c3aed',
    defaultSeverity: 'medium',
    policeRelevant: true,
    hint: 'A lone individual walking in a dark / isolated area.'
  },
  crowd_gathering: {
    label: 'Unusual Crowd',
    icon: '👥',
    color: '#0891b2',
    defaultSeverity: 'medium',
    policeRelevant: true,
    hint: 'A large or unusual gathering of people.'
  },
  flood: {
    label: 'Flooding / Water Logging',
    icon: '🌊',
    color: '#2563eb',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'Roads or area submerged in water.'
  },
  suspicious_activity: {
    label: 'Suspicious Activity',
    icon: '⚠️',
    color: '#be123c',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'Break-in, vandalism, trespassing, or other suspicious behaviour.'
  },
  weapon_threat: {
    label: 'Armed Person / Weapon',
    icon: '🔫',
    color: '#b91c1c',
    defaultSeverity: 'critical',
    policeRelevant: true,
    hint: 'A person visibly carrying or brandishing a weapon (gun, knife, etc.).'
  },
  violence_assault: {
    label: 'Violence / Assault',
    icon: '🥊',
    color: '#9f1239',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'A physical fight, attack, or someone being assaulted.'
  },
  theft_robbery: {
    label: 'Theft / Robbery',
    icon: '🦹',
    color: '#a21caf',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'A robbery, snatching, or theft in progress.'
  },
  medical_emergency: {
    label: 'Medical Emergency',
    icon: '🩺',
    color: '#db2777',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'A person collapsed, unconscious, or lying motionless on the ground.'
  },
  abandoned_object: {
    label: 'Unattended Object',
    icon: '🧳',
    color: '#a16207',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'An unattended bag, package, or suspicious object left in a public place.'
  },
  stampede: {
    label: 'Stampede / Crowd Panic',
    icon: '😱',
    color: '#c2410c',
    defaultSeverity: 'critical',
    policeRelevant: true,
    hint: 'A dangerous crowd surge, crush, or people fleeing in panic.'
  },
  building_collapse: {
    label: 'Building Collapse',
    icon: '🏚️',
    color: '#78350f',
    defaultSeverity: 'critical',
    policeRelevant: true,
    hint: 'A collapsed or severely damaged structure with debris.'
  },
  animal_intrusion: {
    label: 'Animal Intrusion',
    icon: '🐘',
    color: '#4d7c0f',
    defaultSeverity: 'medium',
    policeRelevant: true,
    hint: 'A wild or stray animal (elephant, cattle, dogs) straying into a populated area.'
  },
  electrical_hazard: {
    label: 'Electrical Hazard',
    icon: '⚡',
    color: '#ca8a04',
    defaultSeverity: 'high',
    policeRelevant: true,
    hint: 'A downed or sparking power line, or a transformer fire.'
  }
};

export const INCIDENT_KEYS = Object.keys(INCIDENT_TYPES);

export const SEVERITY_RANK = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function meta(type) {
  return INCIDENT_TYPES[type] || INCIDENT_TYPES.normal;
}
