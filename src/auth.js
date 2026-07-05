// Authentication: password hashing (bcrypt) + stateless signed-cookie sessions.
// The session is a mini-JWT (HMAC-SHA256 signed) stored in an httpOnly cookie, so it
// survives Render restarts without a server-side session store.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const SECRET = process.env.AUTH_SECRET || 'dev-insecure-secret-change-me';
if (!process.env.AUTH_SECRET)
  console.warn('[auth] AUTH_SECRET not set — using an insecure default. Set AUTH_SECRET in your env for production.');

export const COOKIE = 'sd_session';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 days

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const hmac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export async function hashPassword(pw) {
  return bcrypt.hash(String(pw), 10);
}
export async function verifyPassword(pw, hash) {
  try { return await bcrypt.compare(String(pw), hash || ''); } catch { return false; }
}

export function signToken(payload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + MAX_AGE_MS }));
  return `${body}.${hmac(body)}`;
}
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expect = hmac(body);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || !payload.exp || payload.exp < Date.now()) return null;
  return payload; // { id, role, username, exp }
}

export function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function sessionFromReq(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}
export function setSession(res, payload) {
  const secure = !!(process.env.NODE_ENV === 'production' || process.env.RENDER);
  res.cookie(COOKIE, signToken(payload), {
    httpOnly: true, sameSite: 'lax', secure, maxAge: MAX_AGE_MS, path: '/'
  });
}
export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// ---- Express middleware ----
export function requireAuth(req, res, next) {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'not authenticated' });
  req.session = s; next();
}
export function requireAdmin(req, res, next) {
  const s = sessionFromReq(req);
  if (!s) return res.status(401).json({ error: 'not authenticated' });
  if (s.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  req.session = s; next();
}
export function requireAuthPage(req, res, next) {
  const s = sessionFromReq(req);
  if (!s) return res.redirect('/login');
  req.session = s; next();
}
export function requireAdminPage(req, res, next) {
  const s = sessionFromReq(req);
  if (!s) return res.redirect('/login');
  if (s.role !== 'admin') return res.redirect('/');
  req.session = s; next();
}
