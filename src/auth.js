const crypto = require('crypto');

const COOKIE = 'nvr_session';

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({ user, password, secret, sessionHours }) {
  const attempts = new Map(); // ip -> { count, until }

  function issue(res, req) {
    const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + sessionHours * 3600_000 })).toString('base64url');
    const token = `${payload}.${sign(payload, secret)}`;
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionHours * 3600}${secure}`);
  }

  function verify(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig || !safeEqual(sig, sign(payload, secret))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return data.exp > Date.now() ? data : null;
    } catch {
      return null;
    }
  }

  function login(req, res) {
    const ip = req.ip;
    const a = attempts.get(ip);
    if (a && a.until > Date.now()) {
      return res.status(429).json({ error: 'Too many failed attempts, try again later' });
    }
    const { username, password: pw } = req.body || {};
    const ok = safeEqual(username ?? '', user) & safeEqual(pw ?? '', password);
    if (!ok) {
      const count = (a?.count || 0) + 1;
      attempts.set(ip, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    attempts.delete(ip);
    issue(res, req);
    res.json({ ok: true, user });
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  }

  function requireAuth(req, res, next) {
    const s = verify(req);
    if (!s) return res.status(401).json({ error: 'Not logged in' });
    req.user = s.u;
    next();
  }

  return { login, logout, requireAuth, verify };
}

module.exports = { createAuth, parseCookies };
