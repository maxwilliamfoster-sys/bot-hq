// Single-user sign-in (one access code -> session cookie) and bearer auth for the bots.
const COOKIE = "__Host-hq";
const SESSION_DAYS = 180;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60e3;

const enc = new TextEncoder();

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Length-independent constant-time comparison of two strings.
function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function login(db, env, code, ip, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS).toISOString();
  const tries = await db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?")
    .bind(ip, since).first("n");
  await db.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)").bind(ip, now.toISOString()).run();
  if (tries >= MAX_ATTEMPTS) return { ok: false, error: "rate_limited" };
  if (!env.ACCESS_CODE_HASH || !safeEqual(await sha256Hex(String(code ?? "").trim()), env.ACCESS_CODE_HASH)) {
    return { ok: false, error: "bad_code" };
  }
  const token = randomToken();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400e3).toISOString();
  await db.prepare("INSERT INTO sessions (token_hash, expires) VALUES (?, ?)").bind(await sha256Hex(token), expires).run();
  await db.prepare("DELETE FROM login_attempts WHERE at <= ?").bind(since).run();
  return { ok: true, token };
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readToken(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

export async function hasSession(db, request, now = new Date()) {
  const token = readToken(request);
  if (!token) return false;
  const expires = await db.prepare("SELECT expires FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token)).first("expires");
  return !!expires && expires > now.toISOString();
}

export async function logout(db, request) {
  const token = readToken(request);
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

export function bearerOk(request, secret) {
  if (!secret) return false;
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  return safeEqual(h.slice(7), secret);
}
