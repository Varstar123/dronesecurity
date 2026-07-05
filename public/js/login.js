const $ = (id) => document.getElementById(id);

// If already signed in, skip straight to the portal.
fetch('/api/auth/me').then((r) => { if (r.ok) location.href = '/'; }).catch(() => {});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('authError');
  const btn = $('loginBtn');
  err.textContent = '';
  btn.disabled = true;
  const label = btn.innerHTML;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');
    location.href = '/';
  } catch (e2) {
    err.textContent = e2.message;
    btn.disabled = false;
    btn.innerHTML = label;
    if (window.lucide) lucide.createIcons();
  }
});
