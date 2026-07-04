-- Smart City Drone Security System — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
-- (Safe to re-run: uses "if not exists".)

-- ── Drones ────────────────────────────────────────────────────────────────
create table if not exists public.drones (
  id                 text primary key,
  name               text,
  sector             text,
  lat                double precision,
  lng                double precision,
  status             text,          -- monitoring | alerting | dispatched | offline
  battery            int,
  connected          boolean default false,
  live_view          boolean default false,
  active_dispatch_id text,
  last_seen          timestamptz
);

-- ── Alerts (autonomous AI detections needing review) ──────────────────────
create table if not exists public.alerts (
  id                 text primary key,
  drone_id           text,
  drone_name         text,
  sector             text,
  lat                double precision,
  lng                double precision,
  timestamp          timestamptz,
  image_url          text,
  incident_type      text,
  title              text,
  severity           text,
  confidence         real,
  interpretation     text,
  recommended_action text,
  source             text,          -- groq-... | claude-vision | mock-simulation
  status             text,          -- pending_review | escalated | dismissed
  reviewed_by        text,
  reviewed_at        timestamptz,
  review_note        text
);

-- ── Dispatches (police alert drones to a location) ────────────────────────
create table if not exists public.dispatches (
  id              text primary key,
  timestamp       timestamptz,
  lat             double precision,
  lng             double precision,
  address         text,
  incident_type   text,
  description     text,
  officer         text,
  status          text,             -- active | resolved
  assigned_drones jsonb default '[]'::jsonb,
  frames          jsonb default '[]'::jsonb,
  updates         jsonb default '[]'::jsonb,
  arrived         jsonb default '[]'::jsonb,
  resolved_at     timestamptz
);

-- ── Main force log (info escalated to the main police force) ──────────────
create table if not exists public.main_force (
  id            text primary key,
  timestamp     timestamptz,
  source_type   text,               -- alert | dispatch
  source_id     text,
  incident_type text,
  title         text,
  location      text,
  lat           double precision,
  lng           double precision,
  drone_name    text,
  officer       text,
  conveyed      text
);

-- Helpful for showing the newest first in the dashboard.
create index if not exists alerts_ts_idx      on public.alerts (timestamp desc);
create index if not exists dispatches_ts_idx  on public.dispatches (timestamp desc);
create index if not exists main_force_ts_idx  on public.main_force (timestamp desc);

-- The server uses the service_role key (trusted, bypasses RLS), so no RLS
-- policies are required. If you later expose these tables to the browser,
-- enable RLS and add policies.

-- Make the new tables visible to the API immediately (refresh PostgREST cache).
notify pgrst, 'reload schema';
