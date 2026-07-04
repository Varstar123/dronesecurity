// Incident analysis for a single drone camera frame.
//
// Providers (auto-detected, or force with AI_PROVIDER=groq|claude|mock):
//   - "groq":   Groq's OpenAI-compatible vision API (needs GROQ_API_KEY).      FAST + FREE tier.
//   - "claude": Anthropic Claude vision (needs ANTHROPIC_API_KEY).
//   - "mock":   rule/scenario based, fully offline (no key needed).
//
// All return the same shape:
//   { incidentType, title, severity, confidence, interpretation,
//     recommendedAction, source }

import Anthropic from '@anthropic-ai/sdk';
import { INCIDENT_TYPES, INCIDENT_KEYS, meta } from './incidents.js';

// ---- pick a provider ------------------------------------------------------
const forced = (process.env.AI_PROVIDER || '').toLowerCase();
function decideProvider() {
  if (forced === 'groq') return process.env.GROQ_API_KEY ? 'groq' : 'mock';
  if (forced === 'claude') return process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock';
  if (forced === 'mock') return 'mock';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  return 'mock';
}
export const AI_MODE = decideProvider();

const CLAUDE_MODEL = process.env.AI_MODEL || 'claude-opus-4-8';
// Groq multimodal model. If Groq deprecates this, set GROQ_MODEL in .env to a
// current vision model from https://console.groq.com/docs/models
const GROQ_MODEL = process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

export const AI_LABEL =
  AI_MODE === 'groq' ? 'Groq Vision' : AI_MODE === 'claude' ? 'Claude Vision' : 'Standby';

let claude = null;
if (AI_MODE === 'claude') {
  try {
    claude = new Anthropic();
  } catch (err) {
    console.warn('[ai] could not init Anthropic client, using mock:', err.message);
  }
}

console.log(`[ai] analysis provider: ${AI_MODE.toUpperCase()} — ${AI_LABEL}`);

// Build the category list straight from the incident catalogue so the prompt,
// the JSON schema, and the drone/portal dropdowns can never drift apart.
const INCIDENT_LINES = Object.entries(INCIDENT_TYPES)
  .map(([k, v]) => `- ${k}: ${v.hint}`)
  .join('\n');

const SYSTEM_PROMPT = `You are the on-board AI of an autonomous city-surveillance drone.
You receive ONE still frame from the drone's downward/forward camera and must decide whether
it shows a public-safety situation where a police / emergency response could help.

Classify the frame into exactly one incident_type from this list:
${INCIDENT_LINES}

Be calibrated and honest. If you are not reasonably sure it is an incident, use "normal".
"interpretation" must be 1-2 plain sentences describing what YOU (the drone) see and why it
may matter — this is what a human police officer will read. "confidence" is 0.0-1.0.
Remember drones are not perfectly accurate, so a human officer will review your report.`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    incident_type: { type: 'string', enum: INCIDENT_KEYS },
    title: { type: 'string' },
    severity: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] },
    confidence: { type: 'number' },
    interpretation: { type: 'string' },
    recommended_action: { type: 'string' }
  },
  required: ['incident_type', 'title', 'severity', 'confidence', 'interpretation', 'recommended_action'],
  additionalProperties: false
};

function normalize(raw, source) {
  const incidentType = INCIDENT_KEYS.includes(raw.incident_type) ? raw.incident_type : 'normal';
  const m = meta(incidentType);
  let confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.6;
  if (confidence > 1) confidence = confidence / 100; // some models answer 0-100
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    incidentType,
    title: (raw.title || m.label).toString().slice(0, 120),
    severity: ['none', 'low', 'medium', 'high', 'critical'].includes(raw.severity)
      ? raw.severity
      : m.defaultSeverity,
    confidence,
    interpretation: (raw.interpretation || m.hint).toString().slice(0, 600),
    recommendedAction: (
      raw.recommended_action || (m.policeRelevant ? 'Flag for officer review.' : 'Continue monitoring.')
    )
      .toString()
      .slice(0, 300),
    source
  };
}

// Tolerant JSON parse — models sometimes wrap JSON in prose/code fences.
function parseLenient(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {}
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(text.slice(a, b + 1));
    } catch {}
  }
  return {};
}

const USER_TEXT = (ctx) =>
  `Drone ${ctx.droneName || ctx.droneId} is over ${ctx.sector || 'an unknown sector'}. ` +
  `Analyze this surveillance frame and report the incident.`;

// ---- Claude ---------------------------------------------------------------
async function analyzeClaude(imageBase64, context) {
  const resp = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: USER_TEXT(context) }
        ]
      }
    ],
    output_config: { format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } }
  });
  const textBlock = resp.content.find((b) => b.type === 'text');
  return normalize(parseLenient(textBlock && textBlock.text), 'claude-vision');
}

// ---- Groq (OpenAI-compatible) --------------------------------------------
async function analyzeGroq(imageBase64, context) {
  const body = {
    model: GROQ_MODEL,
    temperature: 0.2,
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content:
          SYSTEM_PROMPT +
          '\n\nRespond with ONLY a JSON object (no prose, no code fences) with exactly these keys: ' +
          'incident_type, title, severity, confidence, interpretation, recommended_action.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: USER_TEXT(context) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
        ]
      }
    ]
  };
  // Abort a hung Groq request so a single slow API call can't stall the drone's
  // scan loop (and pile up requests) indefinitely.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return normalize(parseLenient(text), `groq-${GROQ_MODEL.split('/').pop()}`);
}

// ---- Mock scenarios (used when there is no API key) -----------------------
const MOCK_TEMPLATES = {
  normal: {
    titles: ['Area clear', 'Routine patrol - nothing unusual', 'Quiet street'],
    interps: [
      'Normal street activity, light traffic and pedestrians. No hazard detected.',
      'Ordinary daytime scene with no signs of distress or danger.'
    ],
    action: 'No action needed. Continue autonomous monitoring.',
    conf: [0.82, 0.94]
  },
  building_fire: {
    titles: ['Possible building fire', 'Smoke from structure detected'],
    interps: [
      'Thick dark smoke and flames visible from an upper floor of a building. Appears to be an active fire.',
      'Heavy smoke rising from a commercial structure — likely a building fire in progress.'
    ],
    action: 'Alert fire services and dispatch police to secure the area.',
    conf: [0.71, 0.9]
  },
  forest_fire: {
    titles: ['Wildfire / vegetation fire', 'Smoke over green cover'],
    interps: [
      'Large plume of smoke rising over a wooded/vegetated area, consistent with a spreading forest fire.',
      'Flames visible along a tree line with smoke drifting across the sector.'
    ],
    action: 'Notify forest & fire departments; monitor spread direction.',
    conf: [0.68, 0.88]
  },
  traffic_block: {
    titles: ['Traffic standstill', 'Long vehicle congestion'],
    interps: [
      'A long line of stationary vehicles blocking the road for an extended stretch — likely a jam or blockage.',
      'Heavy congestion with vehicles at a standstill across both lanes.'
    ],
    action: 'Inform traffic police to clear the route.',
    conf: [0.66, 0.85]
  },
  road_accident: {
    titles: ['Road accident detected', 'Collision on road'],
    interps: [
      'Two vehicles appear collided with people gathered around — a road accident with possible injuries.',
      'An overturned vehicle on the roadside with bystanders — likely a traffic accident.'
    ],
    action: 'Dispatch ambulance and police to the location immediately.',
    conf: [0.7, 0.89]
  },
  person_alone_at_night: {
    titles: ['Lone person in dark area', 'Individual in isolated spot at night'],
    interps: [
      'A single person walking alone through a poorly lit, isolated area at night — a possible safety concern.',
      'One individual moving through a dark stretch with no one else around.'
    ],
    action: 'Keep tracking; flag for officer review in case assistance is needed.',
    conf: [0.6, 0.8]
  },
  crowd_gathering: {
    titles: ['Unusual crowd', 'Large gathering detected'],
    interps: [
      'An unusually dense crowd has gathered in the area, larger than normal foot traffic.',
      'A large group of people clustered together — reason unclear, worth a look.'
    ],
    action: 'Officer to assess whether the gathering needs monitoring.',
    conf: [0.62, 0.82]
  },
  flood: {
    titles: ['Water logging / flood', 'Flooded road'],
    interps: [
      'A stretch of road is submerged under water, with vehicles struggling to pass — flooding detected.',
      'Standing water covers the area, consistent with flooding or water-logging.'
    ],
    action: 'Alert disaster response; consider closing the route.',
    conf: [0.67, 0.86]
  },
  suspicious_activity: {
    titles: ['Suspicious activity', 'Possible break-in / disturbance'],
    interps: [
      'Individuals behaving suspiciously near a shuttered shop at night — possible break-in attempt.',
      'A person is loitering and tampering with a locked gate.'
    ],
    action: 'Send officer to investigate; keep recording.',
    conf: [0.64, 0.84]
  },
  weapon_threat: {
    titles: ['Armed person detected', 'Weapon spotted'],
    interps: [
      'An individual appears to be carrying a firearm in a public area — a serious threat.',
      'A person is brandishing what looks like a weapon near other people.'
    ],
    action: 'Treat as a high threat — dispatch armed response and keep the public back.',
    conf: [0.6, 0.82]
  },
  violence_assault: {
    titles: ['Physical fight detected', 'Assault in progress'],
    interps: [
      'Two or more people are physically fighting in the street.',
      'A person appears to be violently attacking another individual.'
    ],
    action: 'Dispatch officers immediately to stop the assault.',
    conf: [0.63, 0.85]
  },
  theft_robbery: {
    titles: ['Robbery in progress', 'Snatching / theft detected'],
    interps: [
      'Individuals appear to be robbing a shop — a theft in progress.',
      'A snatch-and-run theft appears to be happening on the street.'
    ],
    action: 'Dispatch the nearest units and track the suspects.',
    conf: [0.62, 0.83]
  },
  medical_emergency: {
    titles: ['Person collapsed', 'Possible medical emergency'],
    interps: [
      'A person is lying motionless on the ground with bystanders gathering — a likely medical emergency.',
      'An individual has collapsed and is not moving.'
    ],
    action: 'Dispatch an ambulance immediately.',
    conf: [0.6, 0.82]
  },
  abandoned_object: {
    titles: ['Unattended object', 'Suspicious package left behind'],
    interps: [
      'An unattended bag has been left in a busy public area — a potential security threat.',
      'A suspicious package sits alone with no owner nearby.'
    ],
    action: 'Cordon off the area and alert the bomb-disposal squad.',
    conf: [0.55, 0.78]
  },
  stampede: {
    titles: ['Crowd panic / stampede', 'Dangerous crowd surge'],
    interps: [
      'A dense crowd is surging and people appear to be fleeing in panic — a stampede risk.',
      'People are pushing and running in panic — a possible crowd crush.'
    ],
    action: 'Send crowd-control units urgently and open the exits.',
    conf: [0.6, 0.82]
  },
  building_collapse: {
    titles: ['Building collapse', 'Structure damaged / debris'],
    interps: [
      'A building has partially collapsed with debris and dust — people may be trapped.',
      'A structure appears severely damaged and partly collapsed.'
    ],
    action: 'Dispatch rescue teams and ambulances.',
    conf: [0.66, 0.87]
  },
  animal_intrusion: {
    titles: ['Animal in populated area', 'Stray / wild animal spotted'],
    interps: [
      'A wild/stray animal has strayed into a populated street — a public-safety risk.',
      'A large animal is moving through the area close to people.'
    ],
    action: 'Alert forest/animal control and warn the public to stay away.',
    conf: [0.6, 0.82]
  },
  electrical_hazard: {
    titles: ['Electrical hazard', 'Downed power line / sparks'],
    interps: [
      'A power line appears downed and sparking near the road — an electrocution and fire risk.',
      'Sparks and flames are coming from an electrical transformer.'
    ],
    action: 'Alert the electricity board and cordon off the area.',
    conf: [0.62, 0.84]
  }
};

const AUTO_WEIGHTS = [
  ['normal', 0.5],
  ['traffic_block', 0.1],
  ['person_alone_at_night', 0.09],
  ['building_fire', 0.07],
  ['road_accident', 0.07],
  ['suspicious_activity', 0.06],
  ['crowd_gathering', 0.05],
  ['flood', 0.03],
  ['forest_fire', 0.03]
];

function weightedPick() {
  const r = Math.random();
  let acc = 0;
  for (const [type, w] of AUTO_WEIGHTS) {
    acc += w;
    if (r <= acc) return type;
  }
  return 'normal';
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function analyzeMock(imageBase64, context) {
  let type = context.scenarioHint;
  if (!type || type === 'auto' || !INCIDENT_KEYS.includes(type)) type = weightedPick();
  const t = MOCK_TEMPLATES[type] || MOCK_TEMPLATES.normal;
  const m = meta(type);
  const [lo, hi] = t.conf;
  const confidence = +(lo + Math.random() * (hi - lo)).toFixed(2);
  return normalize(
    {
      incident_type: type,
      title: pick(t.titles),
      severity: m.defaultSeverity,
      confidence,
      interpretation: pick(t.interps),
      recommended_action: t.action
    },
    'mock-simulation'
  );
}

export async function analyzeFrame(imageBase64, context = {}) {
  try {
    if (AI_MODE === 'groq') return await analyzeGroq(imageBase64, context);
    if (AI_MODE === 'claude' && claude) return await analyzeClaude(imageBase64, context);
  } catch (err) {
    // A real provider failed on this frame (e.g. a blank/black frame, or a rate
    // limit). Do NOT invent a random incident — that produced false alerts.
    // Treat the frame as "all clear" and keep monitoring.
    console.warn(`[ai] ${AI_MODE} analysis failed, treating frame as normal:`, err.message);
    return normalize(
      {
        incident_type: 'normal',
        title: 'All clear',
        severity: 'none',
        confidence: 0.5,
        interpretation: 'AI analysis was unavailable for this frame — continuing to monitor.',
        recommended_action: 'Continue monitoring.'
      },
      `${AI_MODE}-unavailable`
    );
  }
  return analyzeMock(imageBase64, context);
}
