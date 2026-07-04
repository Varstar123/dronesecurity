# 🛰️ Smart City Drone Security System

**S7 B.Tech Main Project · Group 17 · Government Engineering College, Kozhikode**

An AI-based drone surveillance and emergency-response system for a smart city.
A phone camera mounted on a drone acts as the drone's "eye": it flies around,
and when it sees a situation where drone security can help it analyses the image
with AI and reports an **alert to the police station portal** with a timestamp,
the image, and the drone's own interpretation.

It detects **17 danger types** (edit them in one place — `src/incidents.js`):
**building fire**, **forest fire**, **traffic block**, **road accident**,
**person alone in the dark**, **unusual crowd**, **flooding**,
**suspicious activity**, **armed person / weapon**, **violence / assault**,
**theft / robbery**, **medical emergency** (person collapsed),
**unattended / suspicious object**, **stampede / crowd panic**,
**building collapse**, **animal intrusion** (stray elephant, cattle, dogs), and
**electrical hazard** (downed power line).

The system implements **both directions** described in the proposal:

### 1. Drone → Police (autonomous detection)
The drone continuously monitors. When the AI flags an incident it sends an
alert to the portal. Because drones are not perfectly accurate, a **drone
police officer reviews** every alert and decides:
- **Escalate to Main Force** — real emergency, forward it to the main police force, or
- **Situation OK — Resume** — false alarm, tell the drone to keep monitoring.

### 2. Police → Drone (dispatch & surround)
When the main force gets a call (e.g. a **robbery**), the officer enters the
location on the portal. The **nearest drones are dispatched to surround it**
and stream **live footage** straight back to the portal, so the drone police
can watch the situation and convey useful information to the main force.

---

## What's in the box

| Part | URL | Who uses it |
|------|-----|-------------|
| **Police Control Center** | `/` | Drone police + main force |
| **Drone Camera App** | `/drone` | Runs in the phone mounted on the drone |

- **Backend:** Node.js + Express + Socket.IO (real-time)
- **AI:** Claude vision (`@anthropic-ai/sdk`) with a full **offline simulation
  fallback**, so it demos even with no API key or internet
- **Storage:** **Supabase** (Postgres + image Storage) when configured, else a
  local JSON file (`data/store.json`) — nothing to install to run
- **Map:** self-contained SVG fleet/incident map (no external map service)

---

## Quick start

```bash
npm install
npm start
```

Then open **http://localhost:3000/** (the police portal) and
**http://localhost:3000/drone** (the drone app) on the same computer.

> On `localhost` the camera works over plain HTTP. To run the drone app on an
> actual **phone over Wi-Fi**, the browser requires **HTTPS** — the server also
> starts a secure listener and prints a `https://<your-ip>:3443/drone` link.
> Open that on the phone and accept the one-time "self-signed certificate"
> warning, then allow camera access.

### Running the demo without an API key (simulation mode)
1. `npm start` → it prints `AI analysis mode : MOCK`.
2. Open `/drone`, press **Start camera**, choose a **scenario** (Fire, Traffic,
   Robbery…) and press **Scan now** (or turn on Auto-monitor).
3. The alert appears instantly on the police portal — review, escalate, dispatch.

### Running with real AI vision
Copy `.env.example` to `.env` and set **one** of:
- `GROQ_API_KEY=...` — **Groq** vision (fast, free tier; get a key at
  https://console.groq.com/keys). Best for continuous interval scanning.
- `ANTHROPIC_API_KEY=...` — **Claude** vision.

Then `npm start` (the banner shows the active provider) and point the camera at a
real scene — the AI analyses the actual captured frame every interval. If Groq
deprecates the default model, set `GROQ_MODEL` to a current vision model from
https://console.groq.com/docs/models .

### Live camera on demand
On the portal's **Fleet Map** tab, each online drone has a **📹 Live view** button.
Click it to pull a live feed from that drone's camera at any time (independent of
alerts/dispatch); the drone shows a "🔴 police viewing" indicator while watched.

### Cloud database + image storage with Supabase (optional)
Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env` to store everything in a
cloud **Postgres** database (browsable in the Supabase dashboard) and push
captured images to a public **Storage** bucket:
1. Create a Supabase project.
2. Run [`supabase/schema.sql`](supabase/schema.sql) once in the Supabase **SQL Editor**
   (creates the `drones`, `alerts`, `dispatches`, `main_force` tables).
3. Put the **Project URL** and **service/secret key** in `.env`, then `npm start`
   — the banner shows `Data store : Supabase`. The `drone-images` bucket is
   created automatically. Without these vars the app falls back to local storage.

---

## Deploying to the web

This is a **persistent Node + Socket.IO server** (it holds live WebSocket
connections for real-time alerts, dispatch commands and the live camera). Deploy
it on a host that runs a long-lived process:

> ⚠️ **Vercel / Netlify won't work** — they are *serverless* and don't support
> WebSocket/Socket.IO servers, so the function crashes on invocation. Use one of
> the platforms below instead (no code changes needed).

**Render (recommended, free):**
1. [render.com](https://render.com) → **New → Blueprint** → connect this repo
   (it reads [`render.yaml`](render.yaml)), or **New → Web Service** with
   build `npm install` and start `npm start`.
2. Add env vars: `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
   (and optionally `GROQ_MODEL`). Do **not** set `PORT` — Render provides it.
3. Deploy → you get `https://<app>.onrender.com`. Because it's real HTTPS, the
   phone camera works over the internet with **no certificate warning**.

**Railway / Fly.io** work the same way with the same env vars.

---

## Suggested demo script (for the review)

1. **Autonomous alert:** On the phone/drone app, scenario = *Building Fire* →
   **Scan now**. A 🔥 alert with the image + AI interpretation pops up on the
   portal with a sound.
2. **Drone police decision:** On the portal, click **Escalate to Main Force**
   (real) — it appears in the **Main Force Log**; the drone gets "resume
   monitoring". Do a second scenario and **Dismiss** it to show the false-alarm
   path.
3. **Police → drone dispatch:** Go to the **Fleet Map**, click near a drone to
   drop a target → the Dispatch form fills in. Set type = *Suspicious Activity*,
   description = "Robbery in progress", **Dispatch nearest drones**.
4. The **nearest drones surround** the location. The phone/drone switches to
   **live streaming** — its footage shows up in the dispatch's live grid. Type
   an update in **Convey to main force** ("2 suspects, fleeing north") and
   **Resolve** when done.

---

## Environment variables

See [`.env.example`](.env.example). Common ones:

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | Enables **Groq** vision (fast, free tier). Preferred provider. |
| `GROQ_MODEL` | Groq vision model (default `meta-llama/llama-4-scout-17b-16e-instruct`). |
| `ANTHROPIC_API_KEY` | Enables **Claude** vision (alternative). Unset + no Groq = simulation. |
| `AI_PROVIDER` | Force `groq`, `claude`, or `mock`. |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | Use cloud Postgres + image Storage (else local JSON). |
| `CLEAR_SECRET` | Police key for the portal's "Clear images" action (default `police2026`). |
| `PORT` | HTTP port (default `3000`). Managed hosts set this automatically. |
| `HTTPS_PORT` | Local HTTPS port for the phone camera (default `3443`). |

---

## How it works (architecture)

```
   PHONE (drone)                 BACKEND (Node)                 POLICE PORTAL
 ┌───────────────┐   frame     ┌──────────────────┐   push    ┌────────────────┐
 │  camera + AI  │ ─────────▶  │  /api/analyze    │ ────────▶ │  alert queue   │
 │  auto-scan    │   image     │  Claude / mock   │  socket   │  review/decide │
 │               │ ◀───────────│  drone commands  │ ◀──────── │  dispatch form │
 │  live stream  │  dispatch   │  /api/dispatches │  frames   │  live footage  │
 └───────────────┘             └──────────────────┘           └────────────────┘
```

- `src/ai.js` — frame → incident classification (Claude vision or mock).
- `src/incidents.js` — the incident catalogue.
- `src/db.js` — JSON persistence.
- `src/geo.js` — nearest-drone selection for dispatch.
- `server.js` — REST API + Socket.IO real-time layer.
- `public/` — the two web apps (portal + drone).

## Reset between demos
Click **Reset demo** on the portal (top-right) to clear all alerts, dispatches
and logs while keeping the drone fleet.
