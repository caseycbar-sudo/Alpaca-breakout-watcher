// Casey's own sign-in. One owner, one passphrase, sessions held in an HttpOnly cookie.
// AIs never use this door: they connect through the connector with their own grants.

import { type Actor, type Env, HubError, hashPassphrase, now, randomToken, safeEqual, sha256, verifyPassphrase } from "./util";

export const SESSION_COOKIE = "__Host-hub-session";
const SESSION_DAYS = 30;
const MAX_FAILED = 8;
const WINDOW_MS = 15 * 60_000;
export const MIN_PASSPHRASE = 12;

export const OWNER: Omit<Actor, "scopes"> = { kind: "owner", id: "casey", name: "Casey" };

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`)
    .bind(key, value)
    .run();
}

export async function isSetUp(env: Env): Promise<boolean> {
  return (await getSetting(env, "owner_passphrase")) !== null;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function ownerFromRequest(env: Env, request: Request): Promise<Actor | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?1`)
    .bind(await sha256(token))
    .first<{ expires_at: number }>();
  if (!row || row.expires_at < now()) return null;
  return { ...OWNER, scopes: [] };
}

async function startSession(env: Env): Promise<string> {
  const token = randomToken(32);
  const created = now();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?1, ?2, ?3)`)
    .bind(await sha256(token), created, created + SESSION_DAYS * 86_400_000)
    .run();
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(created).run();
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function endSession(env: Env, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256(token)).run();
}

export async function endAllSessions(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions`).run();
}

async function guardAttempts(env: Env): Promise<void> {
  const since = now() - WINDOW_MS;
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND at > ?1`).bind(since).first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_FAILED) {
    throw new HubError(429, "too_many_tries", "Too many wrong tries. Sign-in is paused for 15 minutes.");
  }
}

async function recordAttempt(env: Env, ok: boolean): Promise<void> {
  await env.DB.prepare(`INSERT INTO login_attempts (at, ok) VALUES (?1, ?2)`).bind(now(), ok ? 1 : 0).run();
  await env.DB.prepare(`DELETE FROM login_attempts WHERE at < ?1`).bind(now() - 24 * 3_600_000).run();
}

/** First-time setup: the one-time setup code plus a passphrase Casey chooses. Returns the session cookie. */
export async function setUp(env: Env, setupCode: string, passphrase: string): Promise<string> {
  if (await isSetUp(env)) throw new HubError(409, "already_set_up", "The hub is already set up. Sign in instead.");
  await guardAttempts(env);
  const expected = await getSetting(env, "setup_code_hash");
  if (!expected) throw new HubError(409, "no_setup_code", "No setup code has been issued for this hub yet.");
  const given = await sha256(setupCode.trim());
  if (!safeEqual(given, expected)) {
    await recordAttempt(env, false);
    throw new HubError(401, "wrong_code", "That setup code is not right. Check it and try again.");
  }
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new HubError(400, "weak_passphrase", `Choose a passphrase of at least ${MIN_PASSPHRASE} characters. A short sentence works well.`);
  }
  await setSetting(env, "owner_passphrase", await hashPassphrase(passphrase));
  await env.DB.prepare(`DELETE FROM settings WHERE key = 'setup_code_hash'`).run();
  await recordAttempt(env, true);
  return startSession(env);
}

export async function signIn(env: Env, passphrase: string): Promise<string> {
  await guardAttempts(env);
  const stored = await getSetting(env, "owner_passphrase");
  if (!stored) throw new HubError(409, "not_set_up", "The hub has not been set up yet.");
  if (!(await verifyPassphrase(passphrase, stored))) {
    await recordAttempt(env, false);
    throw new HubError(401, "wrong_passphrase", "That passphrase is not right.");
  }
  await recordAttempt(env, true);
  return startSession(env);
}

export async function changePassphrase(env: Env, current: string, next: string): Promise<string> {
  const stored = await getSetting(env, "owner_passphrase");
  if (!stored || !(await verifyPassphrase(current, stored))) {
    await recordAttempt(env, false);
    throw new HubError(401, "wrong_passphrase", "The current passphrase is not right.");
  }
  if (next.length < MIN_PASSPHRASE) {
    throw new HubError(400, "weak_passphrase", `Choose a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  }
  await setSetting(env, "owner_passphrase", await hashPassphrase(next));
  await endAllSessions(env);
  return startSession(env);
}

/**
 * Forms and API calls that change something must come from the hub's own pages.
 * Browsers label every request with where it came from (Sec-Fetch-Site), so a form
 * on another site is refused. Older browsers fall back to the Origin header.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("Origin");
  if (!origin) return true; // not a browser: there is no session cookie to ride on
  return origin === new URL(request.url).origin;
}

/** Only allow post-sign-in redirects back into the hub itself. */
export function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
