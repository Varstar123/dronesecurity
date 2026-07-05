// Shared helpers for both the police portal and the drone app.

export const SEV_CLASS = {
  none: 'sev-none',
  low: 'sev-low',
  medium: 'sev-medium',
  high: 'sev-high',
  critical: 'sev-critical'
};

export let CONFIG = { aiMode: 'mock', cityCenter: { lat: 11.2588, lng: 75.7804 }, incidentTypes: {} };

export async function loadConfig() {
  try {
    CONFIG = await api('/api/config');
  } catch (e) {
    /* keep defaults */
  }
  return CONFIG;
}

export function incidentMeta(type) {
  return (CONFIG.incidentTypes && CONFIG.incidentTypes[type]) || { label: type, icon: '❓', lucide: 'circle-help', color: '#888' };
}

// ---- Lucide premium icons ----
// icon('name') → inline placeholder that lucide.createIcons() turns into an SVG.
export function icon(name, cls = '') {
  return `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;
}
// A coloured incident icon.
export function incidentIcon(type) {
  const m = incidentMeta(type);
  return `<span style="color:${m.color};display:inline-flex">${icon(m.lucide || 'triangle-alert')}</span>`;
}
// Render all pending <i data-lucide> placeholders into SVGs (call after HTML updates).
export function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

// ---- Theme picker: 4 premium dark palettes, remembered per browser ----
export const THEMES = [
  { id: 'midnight', name: 'Midnight', sw: ['#0d1a27', '#16b0a6'] },
  { id: 'graphite', name: 'Graphite', sw: ['#14161b', '#22c1d6'] },
  { id: 'obsidian', name: 'Obsidian', sw: ['#0b0b14', '#8b7bff'] },
  { id: 'emerald', name: 'Emerald', sw: ['#0a1512', '#10b981'] },
  { id: 'tricolor', name: 'Tricolour', sw: ['#ff9933', '#138808'] },
  { id: 'aurora', name: 'Aurora', sw: ['#5b8cff', '#d24bf0'] }
];
export function currentTheme() {
  try { return localStorage.getItem('sd-theme') || 'midnight'; } catch { return 'midnight'; }
}
export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem('sd-theme', id); } catch {}
}
// onChange(id) fires only on USER-initiated changes (so callers can persist to the
// account). Returns { apply(id) } to set the theme programmatically (e.g. from the
// signed-in officer's saved preference) without re-triggering onChange.
export function initThemePicker(mount, onChange) {
  const el = typeof mount === 'string' ? document.getElementById(mount) : mount;
  if (!el) return { apply() {} };
  let cur = currentTheme();
  applyTheme(cur);
  const sw = (t) => `<span class="theme-sw"><i style="background:${t.sw[0]}"></i><i style="background:${t.sw[1]}"></i></span>`;
  const curT = () => THEMES.find((t) => t.id === cur) || THEMES[0];
  el.innerHTML =
    `<button class="theme-btn" id="themeBtn" title="Change theme" aria-haspopup="true"><span class="theme-cur">${sw(curT())}</span><span>Theme</span></button>` +
    `<div class="theme-menu" id="themeMenu">` +
    THEMES.map((t) => `<button class="theme-opt" data-theme-id="${t.id}">${sw(t)}<span>${t.name}</span><span class="theme-check" data-check="${t.id}">${icon('check')}</span></button>`).join('') +
    `</div>`;
  const menu = el.querySelector('#themeMenu');
  const btn = el.querySelector('#themeBtn');
  const mark = () => el.querySelectorAll('[data-check]').forEach((c) => (c.style.visibility = c.dataset.check === cur ? 'visible' : 'hidden'));
  const refresh = () => { const s = el.querySelector('.theme-cur'); if (s) s.innerHTML = sw(curT()); mark(); };
  refresh();
  btn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
  el.querySelectorAll('[data-theme-id]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    cur = b.dataset.themeId;
    applyTheme(cur);
    refresh();
    menu.classList.remove('open');
    refreshIcons();
    if (typeof onChange === 'function') onChange(cur);
  }));
  document.addEventListener('click', () => menu.classList.remove('open'));
  refreshIcons();
  return {
    apply(id) {
      if (!id || id === cur || !THEMES.some((t) => t.id === id)) return;
      cur = id; applyTheme(id); refresh(); refreshIcons();
    }
  };
}
