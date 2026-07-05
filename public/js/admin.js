import { api, esc, icon, refreshIcons } from '/js/common.js';

const $ = (id) => document.getElementById(id);
const DEFAULT_AVATAR = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'><rect width='96' height='96' fill='%231a3450'/><circle cx='48' cy='40' r='16' fill='%238ba6c0'/><path d='M22 82c0-14 12-22 26-22s26 8 26 22z' fill='%238ba6c0'/></svg>";

let me = null;
let officers = [];
let editingId = null;

init();
async function init() {
  try { me = await api('/api/auth/me'); } catch { location.href = '/login'; return; }
  if (me.role !== 'admin') { location.href = '/'; return; }
  $('logoutBtn').onclick = logout;
  $('addBtn').onclick = () => openEditor(null);
  $('editCancel').onclick = closeEditor;
  // Intentionally NO backdrop-click-to-close — the editor only closes via Cancel/Save,
  // so a stray click outside can't discard a half-filled officer form.
  $('officerForm').addEventListener('submit', saveOfficer);
  await load();
}

async function load() {
  try { officers = await api('/api/officers'); } catch { officers = []; }
  $('offCount').textContent = officers.length;
  render();
}

function officerCard(o) {
  const roleBadge = o.role === 'admin' ? '<span class="sev sev-high">ADMIN</span>' : '<span class="chip">Officer</span>';
  const status = o.active === false
    ? '<span class="chip" style="color:#f6b45f;border-color:#a4611f">inactive</span>'
    : '<span class="chip" style="color:#7cffb0;border-color:#0f7d76">active</span>';
  const isSelf = o.id === me.id;
  return `<div class="off-card">
    <div class="off-top">
      <img class="off-photo" src="${esc(o.photo || DEFAULT_AVATAR)}" alt="" onerror="this.src='${DEFAULT_AVATAR}'" />
      <div class="off-id">
        <div class="off-name">${esc(o.name || o.username)}</div>
        <div class="meta">@${esc(o.username)}</div>
      </div>
    </div>
    <div class="off-rows">
      <div class="meta">${icon('map-pin')} ${esc(o.station || '—')}</div>
      <div class="meta">Badge · ${esc(o.badgeId || '—')}</div>
      <div class="row" style="gap:6px; margin-top:4px; flex-wrap:wrap">${roleBadge} ${status}${isSelf ? ' <span class="chip">you</span>' : ''}</div>
    </div>
    <div class="actions">
      <button class="btn sm" data-edit="${o.id}">${icon('pencil')} Edit</button>
      <button class="btn sm danger" data-del="${o.id}" ${isSelf ? 'disabled' : ''}>${icon('trash-2')} Delete</button>
    </div>
  </div>`;
}

function render() {
  const wrap = $('officerList');
  wrap.innerHTML = officers.length ? officers.map(officerCard).join('') : '<div class="empty">No officers yet — add one to get started.</div>';
  wrap.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  wrap.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => del(b.dataset.del)));
  refreshIcons();
}

function openEditor(id) {
  editingId = id;
  const o = id ? officers.find((x) => x.id === id) : null;
  $('editTitle').textContent = o ? `Edit ${o.name || o.username}` : 'Add officer';
  $('f_name').value = o ? (o.name || '') : '';
  $('f_username').value = o ? o.username : '';
  $('f_username').disabled = !!o; // username is the login key — don't rename it here
  $('f_badge').value = o ? (o.badgeId || '') : '';
  $('f_role').value = o ? o.role : 'officer';
  $('f_station').value = o ? (o.station || '') : '';
  $('f_password').value = '';
  $('f_password').placeholder = o ? 'Leave blank to keep current password' : 'Set a password';
  $('pwLabel').innerHTML = o ? 'New password <span class="small">(optional)</span>' : 'Password';
  $('editError').textContent = '';
  $('editBack').classList.add('open');
  $('f_name').focus();
}
function closeEditor() { $('editBack').classList.remove('open'); editingId = null; }

async function saveOfficer(e) {
  e.preventDefault();
  const err = $('editError');
  err.textContent = '';
  const pw = $('f_password').value;
  const body = {
    name: $('f_name').value.trim(),
    badgeId: $('f_badge').value.trim(),
    role: $('f_role').value,
    station: $('f_station').value.trim()
  };
  if (pw) body.password = pw;
  const btn = $('editSave');
  btn.disabled = true;
  try {
    if (editingId) {
      await api(`/api/officers/${editingId}`, { method: 'PATCH', body });
    } else {
      body.username = $('f_username').value.trim();
      if (!body.username || !pw) throw new Error('Username and password are required for a new officer.');
      await api('/api/officers', { method: 'POST', body });
    }
    closeEditor();
    await load();
  } catch (e2) {
    err.textContent = e2.message;
  } finally {
    btn.disabled = false;
  }
}

async function del(id) {
  const o = officers.find((x) => x.id === id);
  if (!confirm(`Delete officer "${o ? (o.name || o.username) : id}"? This cannot be undone.`)) return;
  try { await api(`/api/officers/${id}`, { method: 'DELETE' }); await load(); }
  catch (e) { alert(e.message); }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
}
