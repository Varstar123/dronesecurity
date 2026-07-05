# System Diagrams

A visual reference for the **Smart City Drone Security System** (GEC Kozhikode, S7 Group 17). Every diagram below is derived directly from the source code; each carries a short caption and the primary files it was built from. Relationships shown for the database are **logical** — the schema declares no foreign-key constraints (`supabase/schema.sql`), so links are drawn to communicate intent, not enforced integrity.

---

## 1. System Architecture

High-level view of the whole system: two static browser apps, one persistent Node process that serves HTTP + a Socket.IO real-time layer, a pluggable vision provider, and a pluggable persistence/image-storage tier.

```mermaid
graph TB
    subgraph Clients["Browser Clients (static HTML + vanilla JS, no build step)"]
        Portal["Police Control Center<br/>index.html + portal.js<br/>(login-gated)"]
        DroneApp["Drone Camera Unit<br/>drone.html + drone.js<br/>(open, field phone)"]
        Admin["Admin Console<br/>admin.html<br/>(admin-only)"]
    end

    subgraph Server["Node process — server.js"]
        HTTP["Express 5 HTTP API<br/>REST /api/*"]
        WS["Socket.IO realtime<br/>rooms: police / drones / drone:id"]
        AI["Vision analysis<br/>src/ai.js"]
        Geo["Geo + dispatch selection<br/>src/geo.js"]
        Auth["Auth: bcrypt + signed cookie<br/>src/auth.js"]
        DB["In-memory state + persistence<br/>src/db.js"]
    end

    subgraph Providers["Vision Providers (auto-selected once at boot)"]
        Groq["Groq Vision<br/>llama-4-scout"]
        Claude["Claude Vision<br/>Anthropic SDK"]
        Mock["Mock simulation<br/>offline templates"]
    end

    subgraph Persistence["Persistence tier (chosen by env)"]
        Supa["Supabase<br/>Postgres + Storage bucket 'drone-images'"]
        Local["Local fallback<br/>data/store.json + data/uploads/"]
    end

    Portal -->|"HTTPS + WebSocket"| HTTP
    Portal -.->|"realtime"| WS
    DroneApp -->|"POST /api/analyze"| HTTP
    DroneApp -.->|"binary frames + GPS"| WS
    Admin --> HTTP

    HTTP --> Auth
    HTTP --> AI
    HTTP --> Geo
    HTTP --> DB
    WS --> DB
    WS --> Geo

    AI --> Groq
    AI --> Claude
    AI --> Mock

    DB -->|"if SUPABASE_URL + SUPABASE_SECRET_KEY"| Supa
    DB -->|"always writes backup / else primary"| Local
```

*Grounded in: `server.js:43-51`, `src/ai.js:17-25`, `src/geo.js:22-31`, `src/db.js:1-6,161-178`, `src/supa.js:7-13`.*

---

## 2. Frontend Architecture

The two front-end apps share a common helper module and the Socket.IO client. The police portal additionally uses Leaflet and an ASCII ripple effect; the drone app owns the camera capture pipeline. There is no bundler — modules are loaded as native ES modules.

```mermaid
graph TB
    subgraph Shared["public/js/common.js (ES module, imported by both)"]
        CFG["CONFIG + loadConfig()<br/>GET /api/config"]
        API["api() fetch wrapper"]
        THEME["THEMES (6) + initThemePicker()<br/>localStorage['sd-theme']"]
        HELPERS["esc / timeAgo / fmtTime<br/>incidentMeta / icon / refreshIcons"]
    end

    subgraph PortalSide["Police Portal — index.html"]
        PJS["portal.js<br/>const socket = io()"]
        LEAF["Leaflet map<br/>initMap / renderMap"]
        RIPPLE["ascii-ripple.js<br/>attachAsciiRipple()"]
        PSTATE["state = {drones, alerts,<br/>dispatches, mf, liveFrames...}"]
        PJS --> LEAF
        PJS --> RIPPLE
        PJS --> PSTATE
    end

    subgraph DroneSide["Drone Camera Unit — drone.html"]
        DJS["drone.js<br/>const socket = io()"]
        CAM["Camera pipeline<br/>captureFrame / captureBlob"]
        DSTATE["st = {droneId, coords, stream,<br/>timers, dispatch, gpsWatch...}"]
        DEVID["DEVICE_ID<br/>localStorage['droneDeviceId']"]
        DJS --> CAM
        DJS --> DSTATE
        DJS --> DEVID
    end

    PJS --> CFG
    PJS --> API
    PJS --> THEME
    PJS --> HELPERS
    DJS --> CFG
    DJS --> API
    DJS --> THEME
    DJS --> HELPERS

    PJS -.->|"socket.io.js"| SIO["Socket.IO client"]
    DJS -.->|"socket.io.js"| SIO
```

*Grounded in: `public/js/common.js:11-127`, `public/js/portal.js:1-5`, `public/js/drone.js:1-37`, `public/index.html:220-224`, `public/drone.html:99-102`.*

---

## 3. Backend Architecture

Request flow inside `server.js`: middleware order is load-bearing — page routes and auth routes are registered before the `/api/*` access guard, and static serving is mounted with `index:false` so login-gating cannot be bypassed.

```mermaid
graph TB
    Req["Incoming HTTP request"] --> Comp["compression() — gzip all"]
    Comp --> JSON["express.json({limit:'15mb'})"]
    JSON --> Pages{"Page route?"}

    Pages -->|"/login (open)"| L["login.html"]
    Pages -->|"/ · /index.html<br/>requireAuthPage"| I["index.html"]
    Pages -->|"/admin · /admin.html<br/>requireAdminPage"| Adm["admin.html"]
    Pages -->|"/drone (open)"| Dr["drone.html"]
    Pages -->|"else"| Static["express.static(public, index:false)<br/>+ /uploads (7d immutable)"]

    Static --> AuthAPI["/api/auth/* (open handlers)"]
    Static --> Guard{"API access guard<br/>server.js:122-127"}

    Guard -->|"non /api/ path"| Pass["next()"]
    Guard -->|"OPEN_API set:<br/>/api/config, /api/drones, /api/analyze"| Pass
    Guard -->|"OPEN_API_RE:<br/>.../live/frame, .../frame"| Pass
    Guard -->|"everything else"| RA["requireAuth"]

    RA --> Routes["Protected routes"]
    Pass --> Routes

    subgraph Routes["Route groups"]
        Officers["Officers CRUD<br/>requireAdmin"]
        Reads["Reads: /alerts /dispatches<br/>/mainforce /stats"]
        Analyze["POST /api/analyze<br/>→ analyzeFrame → maybe alert"]
        Review["Alert actions<br/>escalate / dismiss"]
        Dispatch["Dispatch lifecycle<br/>create / frame / convey / resolve"]
        Live["Live camera<br/>start / stop / frame"]
        AdminOps["Admin ops<br/>reset / clear-images / resolve-location"]
    end

    Routes --> DB["db (in-memory state)"]
    DB -->|"persist() debounced 300ms"| Store["store.json / Supabase sync"]
    Routes -.->|"toPolice / toDrone emits"| IO["Socket.IO rooms"]
```

*Grounded in: `server.js:58-70` (middleware), `server.js:120-127` (guard), `server.js:130-887` (routes), `server.js:248-249` (emit helpers), `src/db.js:85-92` (debounced persist).*

---

## 4. Authentication Flow

Auth is stateless: a bcrypt-verified login mints an HMAC-SHA256-signed mini-JWT (`body.signature`, not a standard 3-part JWT) stored in the httpOnly `sd_session` cookie. Every protected request re-verifies the cookie — there is no server-side session store.

```mermaid
sequenceDiagram
    participant B as Browser
    participant S as server.js
    participant O as officers store<br/>(Supabase or JSON)
    participant A as src/auth.js

    Note over B,A: Login
    B->>S: POST /api/auth/login {username, password}
    S->>O: findByUsername(username)
    O-->>S: officer record (or null)
    alt no user / inactive / bad password
        S-->>B: 401 Invalid username or password
    else valid
        S->>A: verifyPassword(pw, passwordHash) — bcrypt.compare
        A-->>S: true
        S->>A: setSession(res, {id, role, username})
        A->>A: signToken → base64url(body).hmac(body)
        A-->>B: Set-Cookie sd_session (httpOnly, sameSite lax,<br/>secure in prod, 7-day maxAge)
        S-->>B: publicOfficer (passwordHash stripped)
    end

    Note over B,A: Subsequent protected request
    B->>S: GET /api/alerts (Cookie: sd_session)
    S->>A: requireAuth → sessionFromReq(req)
    A->>A: verifyToken: timingSafeEqual(sig) + exp check
    alt invalid or expired
        A-->>B: 401 not authenticated
    else valid
        A->>S: req.session = {id, role, username, exp}
        S-->>B: 200 data
    end

    Note over B,A: Page gating (requireAuthPage / requireAdminPage)
    B->>S: GET / (no valid cookie)
    S-->>B: 302 redirect → /login
```

*Grounded in: `server.js:73-95` (login/logout/me), `src/auth.js:15-86` (hashing, token, middleware), `src/officers.js:57-61` (publicOfficer). The default admin (`username: admin`, password from `ADMIN_PASSWORD` or `admin123`) is seeded at startup if no admin exists — `src/officers.js:64-75`.*

---

## 5. User Flow

The end-to-end operational journey across both apps: a field phone brings a drone online and streams frames for autonomous analysis; officers triage alerts in the portal and dispatch drones to incidents.

```mermaid
flowchart TD
    Start(["Officer opens portal"]) --> Login{"Valid session?"}
    Login -->|no| Redir["Redirect /login → sign in"]
    Login -->|yes| Dash["Dashboard: stats, alerts,<br/>dispatches, map, main-force"]
    Redir --> Dash

    subgraph Field["Field device — /drone"]
        Open["Open drone app"] --> Claim["Pick a free drone →<br/>drone:hello {droneId, deviceId}"]
        Claim --> CamStart["Start camera + GPS"]
        CamStart --> Auto["Auto-monitor loop:<br/>POST /api/analyze every 5/8/15s"]
    end

    Auto -->|"incident detected"| NewAlert["alert:new pushed to portal"]
    Dash --> NewAlert
    NewAlert --> Review{"Officer reviews<br/>pending alert"}
    Review -->|"Dismiss"| Dismissed["status = dismissed<br/>drone resumes monitoring"]
    Review -->|"Escalate"| Escalated["status = escalated →<br/>main-force record created"]

    Escalated --> Decide{"Send drones<br/>to the scene?"}
    Dash --> Decide
    Decide -->|"POST /api/dispatches"| Disp["findNearbyDrones picks online drones<br/>→ drone:command 'dispatch'"]
    Disp --> Stream["Drones stream live footage +<br/>GPS to portal"]
    Stream --> Arrive{"Within 20 m<br/>of target?"}
    Arrive -->|yes| Arrived["dispatch:arrived toast + beep"]
    Arrive -->|no| Stream
    Arrived --> Convey["Drone police convey field updates →<br/>main force"]
    Convey --> Resolve["POST /api/dispatches/:id/resolve →<br/>drones freed, resume monitoring"]
```

*Grounded in: `server.js:319-408` (analyze), `server.js:412-486` (escalate/dismiss), `server.js:490-563` (dispatch), `server.js:277-291` (arrival), `server.js:610-676` (convey/resolve), `public/js/drone.js:234-295` (scan/auto-monitor).*

---

## 6. Sequence — Frame → AI → Alert → Review → Dispatch

The core incident lifecycle, from an autonomous capture on the drone through officer review to a dispatch back onto the fleet. Note `/api/analyze` re-validates the drone state *after* its awaits so a drone that got dispatched mid-analysis is never demoted, and duplicate pending alerts per drone are suppressed.

```mermaid
sequenceDiagram
    autonumber
    participant D as Drone app<br/>(drone.js)
    participant S as server.js
    participant AI as src/ai.js
    participant P as Provider<br/>(Groq / Claude / Mock)
    participant DB as db / storage
    participant PO as Police portal<br/>(portal.js)

    D->>S: POST /api/analyze {droneId, image, lat, lng, scenarioHint}
    S->>DB: find drone; set lat/lng, connected=true
    S->>AI: analyzeFrame(imageBase64, {droneName, sector, scenarioHint})
    AI->>P: vision request (image + SYSTEM_PROMPT)
    alt provider error / timeout
        P-->>AI: throw
        AI-->>S: normalized "All clear" (normal, never a random incident)
    else success
        P-->>AI: JSON {incident_type, severity, confidence...}
        AI-->>S: normalize() → camelCase result
    end

    alt incidentType != normal AND policeRelevant
        S->>DB: dedupe check (existing pending alert for drone?)
        S->>DB: saveImage(image) → Storage/local URL
        Note over S: Re-validate after awaits —<br/>suppress if drone now dispatched
        S->>DB: push alert {status: pending_review}, cap MAX_ALERTS
        S->>DB: drone.status = 'alerting'
        S-->>PO: emit alert:new (+ toast + alarm)
    end
    S-->>PO: emit drone:status + stats
    S-->>D: 200 {analysis, alert}

    Note over PO: Officer triages the pending alert
    PO->>S: POST /api/alerts/:id/escalate {officer, note}
    S->>DB: alert.status = 'escalated'; push main_force record
    S-->>PO: emit alert:updated + mainforce:new + stats
    S-->>D: drone:command 'resume' (if not on a dispatch)

    Note over PO: Escalated incident warrants boots on the scene
    PO->>S: POST /api/dispatches {lat, lng, incidentType, description}
    S->>S: findNearbyDrones(target, drones, radiusKm=3)
    alt no dispatchable drone
        S-->>PO: 409 (no drones online / all busy)
    else drones selected
        S->>DB: create dispatch; mark drones dispatched
        S-->>D: drone:command 'dispatch' {dispatchId, lat, lng}
        S-->>PO: emit dispatch:new + drone:status + stats
        D-->>PO: drone:dispframe (binary) → dispatch:frame:bin (live footage)
        D->>S: drone:location → checkArrival (<=20 m) → dispatch:arrived
    end
```

*Grounded in: `server.js:319-408` (analyze + re-validation), `src/ai.js:402-424` (fallback), `src/ai.js:78-100` (normalize), `server.js:412-457` (escalate), `server.js:490-563` (dispatch), `server.js:1048-1074` (binary dispatch frames), `server.js:277-291` (arrival).*

---

## 7. Database ER Diagram

The persisted schema (`supabase/schema.sql`). All primary keys are opaque `text` ids (e.g. `alert_…`, `disp_…`). **No foreign keys are declared** — `drone_id`, `source_id`, and `active_dispatch_id` are plain text; the relationships below are logical associations the application maintains in code, drawn here for clarity only. When Supabase is disabled, the same shape is mirrored in `data/store.json` (drones/alerts/dispatches/main_force) and `data/officers.json`.

```mermaid
erDiagram
    DRONES ||--o{ ALERTS : "raises (drone_id, logical)"
    DRONES ||--o{ DISPATCHES : "assigned via assigned_drones jsonb (logical)"
    ALERTS ||--o| MAIN_FORCE : "escalated → source_id (logical)"
    DISPATCHES ||--o{ MAIN_FORCE : "field updates → source_id (logical)"
    OFFICERS }o..o{ ALERTS : "reviews (reviewed_by, by name)"

    DRONES {
        text id PK
        text name
        text sector
        double lat
        double lng
        text status "monitoring|alerting|dispatched|offline"
        int battery
        boolean connected "default false"
        boolean live_view "default false"
        text active_dispatch_id
        timestamptz last_seen
    }

    ALERTS {
        text id PK
        text drone_id
        text drone_name
        text sector
        double lat
        double lng
        timestamptz timestamp
        text image_url
        text incident_type
        text title
        text severity
        real confidence
        text interpretation
        text recommended_action
        text source "groq|claude-vision|mock-simulation"
        text status "pending_review|escalated|dismissed"
        text reviewed_by
        timestamptz reviewed_at
        text review_note
    }

    DISPATCHES {
        text id PK
        timestamptz timestamp
        double lat
        double lng
        text address
        text incident_type
        text description
        text officer
        text status "active|resolved"
        jsonb assigned_drones "default []"
        jsonb frames "default []"
        jsonb updates "default []"
        jsonb arrived "default []"
        timestamptz resolved_at
    }

    MAIN_FORCE {
        text id PK
        timestamptz timestamp
        text source_type "alert|dispatch"
        text source_id
        text incident_type
        text title
        text location
        double lat
        double lng
        text drone_name
        text officer
        text conveyed
    }

    OFFICERS {
        text id PK
        text username UK "unique not null"
        text password_hash "bcrypt, not null"
        text name
        text badge_id
        text station
        text photo
        text role "default officer"
        boolean active "default true"
        text theme
        timestamptz created_at "default now()"
    }
```

*Grounded in: `supabase/schema.sql:6-96`. Indexes: `officers (lower(username))`, and `timestamp desc` on alerts/dispatches/main_force (`schema.sql:91-96`). No RLS (server uses the trusted service_role key, `schema.sql:98-100`).*

---

## 8. Component Relationships

Module dependency graph of the server-side code. `server.js` is the composition root; every `src/*` module is imported there. `db.js` and `officers.js` each choose Supabase vs. local independently based on `supa.SUPA_ENABLED`.

```mermaid
graph LR
    SRV["server.js<br/>(composition root)"]

    SRV --> AUTH["auth.js<br/>bcrypt + signed cookie"]
    SRV --> OFF["officers.js<br/>account store"]
    SRV --> DB["db.js<br/>in-memory + persist"]
    SRV --> AI["ai.js<br/>analyzeFrame"]
    SRV --> GEO["geo.js<br/>haversine + findNearby"]
    SRV --> INC["incidents.js<br/>INCIDENT_TYPES catalogue"]
    SRV --> SEED["seed.js<br/>seedFleet / LANDMARKS"]
    SRV --> SUPA["supa.js<br/>Supabase adapter"]

    OFF --> AUTH
    OFF --> SUPA
    DB --> SUPA
    AI --> INC
    SEED --> DB
    SEED --> GEO_note["CITY_CENTER / HOME_POSITIONS"]

    AI --> ANTH["@anthropic-ai/sdk"]
    AI --> GROQ_HTTP["fetch → api.groq.com"]
    SUPA --> SBJS["@supabase/supabase-js"]
    AUTH --> BCRYPT["bcryptjs"]
    SRV --> EXPRESS["express 5 + compression"]
    SRV --> SOCKETIO["socket.io"]

    classDef ext fill:#334155,stroke:#64748b,color:#e2e8f0;
    class ANTH,GROQ_HTTP,SBJS,BCRYPT,EXPRESS,SOCKETIO ext;
```

*Grounded in: `server.js:12-29` (imports), `src/officers.js:12` (SUPA branch), `src/db.js:161-178`, `src/ai.js:12,36`, `src/seed.js:15-78`, `package.json:23-32` (deps).*

---

## 9. Deployment Architecture

Local development runs both an HTTP listener (`PORT`, default 3000) and a self-signed HTTPS listener (`HTTPS_PORT`, default 3443) so a phone camera can stream over LAN Wi-Fi. On managed hosts (`NODE_ENV=production`, `RENDER`, or `RAILWAY_ENVIRONMENT` set) the local HTTPS listener is skipped because the platform terminates TLS at its edge.

```mermaid
graph TB
    subgraph Local["Local / LAN development"]
        Dev["node server.js"]
        Dev --> H1["HTTP :3000<br/>(localhost camera OK)"]
        Dev --> H2["HTTPS :3443 self-signed<br/>(phone camera over Wi-Fi)"]
        Phone["Field phone<br/>https://LAN-IP:3443/drone"] -.-> H2
        LocalStore["data/store.json<br/>data/uploads/<br/>data/officers.json"]
        Dev --> LocalStore
    end

    subgraph Cloud["Managed host (Render Blueprint — render.yaml)"]
        Edge["Render edge<br/>TLS termination + public https URL"]
        Node["Web service 'dronesecurity'<br/>runtime node, plan free<br/>build: npm install · start: npm start<br/>health: /api/stats"]
        Edge --> Node
        Note1["NODE_ENV=production ⇒<br/>skip local HTTPS, secure cookies"]
        Node -.-> Note1
    end

    subgraph SupaCloud["Supabase (optional, if keys set)"]
        PG["Postgres<br/>drones · alerts · dispatches<br/>main_force · officers"]
        Bucket["Storage bucket<br/>'drone-images'"]
    end

    Internet(["Officers + field phones"]) -->|"https"| Edge
    Node -->|"SUPABASE_URL + SUPABASE_SECRET_KEY"| PG
    Node --> Bucket

    Note2["Vercel/Netlify unsupported<br/>(no persistent WebSocket).<br/>Railway/Fly.io work with same env."]
    Cloud -.-> Note2
```

*Grounded in: `server.js:32-33` (ports), `server.js:1164-1184` (HTTPS gating + `io.attach`), `render.yaml:5-23` (service + env), `src/supa.js:7-10` (Supabase selection), `src/db.js:6` (JSON backup always written), `README:106-123` (host constraints).*

---

### Legend / conventions

- **Solid arrows** — direct call, import, or request path.
- **Dashed arrows** — realtime Socket.IO emits, or conditional/notational links.
- **ER links** are logical only; the schema declares no foreign keys (`supabase/schema.sql`).
- Provider, persistence, and TLS choices are all resolved from environment variables at boot, not at request time.
