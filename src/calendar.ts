// Scheduled macro and political calendar posted by the read-only watcher.
// The Hub stores display-safe schedule facts only. It never predicts direction.

import * as db from "./db";
import { type Env, HubError, safeEqual } from "./util";

const STORE_KEY = "overview_macro_calendar_latest";
const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENTS = 80;
const STALE_AFTER_MS = 6 * 60 * 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number): string | null => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const instant = (v: unknown): string | null => {
  const s = text(v, 60);
  if (!s || !/^\d{4}-\d{2}-\d{2}[Tt ].*(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const ms = Date.parse(s.replace(" ", "T"));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const link = (v: unknown): string | null => {
  const s = text(v, 800);
  if (!s) return null;
  try { const u = new URL(s); return u.protocol === "https:" ? u.href : null; } catch { return null; }
};

export interface CalendarEvent {
  id: string | null; title: string; kind: string; source: string; url: string;
  event_at: string; first_seen_at: string; period: string | null;
}
export interface CalendarSource { name: string; status: "ok" | "late" | "unavailable"; checked_at: string | null; }
interface Stored {
  received_at: number; checked_at: string; trading_days: string[];
  events: CalendarEvent[]; sources: CalendarSource[];
}

export function clean(payload: unknown, receivedAt = Date.now()): Stored {
  const p = obj(payload);
  const checked_at = instant(p.checked_at) ?? new Date(receivedAt).toISOString();
  const trading_days = Array.isArray(p.trading_days)
    ? [...new Set(p.trading_days.map(x => text(x, 10)).filter((x): x is string => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x)))].slice(0, 5)
    : [];
  const events = (Array.isArray(p.events) ? p.events : []).slice(0, MAX_EVENTS).map(obj).map((row): CalendarEvent | null => {
    const title = text(row.title, 240), source = text(row.source, 80), url = link(row.url);
    const event_at = instant(row.event_at), first_seen_at = instant(row.first_seen_at);
    if (!title || !source || !url || !event_at || !first_seen_at) return null;
    if (Date.parse(first_seen_at) > receivedAt + MAX_CLOCK_SKEW_MS) return null;
    return {
      id: text(row.id, 120), title, source, url, event_at, first_seen_at,
      kind: text(row.kind, 40) ?? "scheduled event", period: text(row.period, 120),
    };
  }).filter((x): x is CalendarEvent => !!x)
    .sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  const sources = (Array.isArray(p.sources) ? p.sources : []).slice(0, 12).map(obj).map((row): CalendarSource | null => {
    const name = text(row.name, 80), status = text(row.status, 20);
    if (!name || !status || !["ok", "late", "unavailable"].includes(status)) return null;
    return { name, status: status as CalendarSource["status"], checked_at: instant(row.checked_at) };
  }).filter((x): x is CalendarSource => !!x);
  return { received_at: receivedAt, checked_at, trading_days, events, sources };
}

export async function receive(env: Env & { RADAR_TOKEN?: string }, request: Request) {
  const expected = env.RADAR_TOKEN;
  if (!expected) throw new HubError(503, "calendar_not_set_up", "The Hub has no watcher token, so it is not accepting calendar updates yet.");
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, expected)) throw new HubError(401, "bad_calendar_token", "That token does not match the watcher token.");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new HubError(413, "calendar_too_big", "That calendar update is larger than the Hub accepts.");
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new HubError(400, "calendar_not_json", "That calendar update was not readable JSON."); }
  const stored = clean(payload);
  await db.setSetting(env, STORE_KEY, JSON.stringify(stored));
  return stored;
}

export async function current(env: Env) {
  const raw = await db.getSetting(env, STORE_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (!Number.isFinite(stored.received_at) || !Array.isArray(stored.events) || !Array.isArray(stored.sources)) return null;
    const age_minutes = Math.max(0, Math.floor((Date.now() - stored.received_at) / 60_000));
    return { ...stored, age_minutes, stale: Date.now() - stored.received_at > STALE_AFTER_MS };
  } catch { return null; }
}
