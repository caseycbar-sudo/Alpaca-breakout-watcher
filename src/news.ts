// Timestamped market headlines posted by the watcher. The Hub never owns an
// Alpaca credential: the watcher sends only display-safe facts over the same
// bearer-token boundary as radar.

import * as db from "./db";
import { type Env, HubError, safeEqual } from "./util";

const STORE_KEY = "overview_news_latest";
const MAX_BODY_BYTES = 96 * 1024;
const MAX_ITEMS = 30;
const STALE_AFTER_MS = 15 * 60_000;
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
const symbols = (v: unknown): string[] => Array.isArray(v)
  ? [...new Set(v.map(x => text(x, 12)?.toUpperCase()).filter((x): x is string => !!x && /^[A-Z0-9./-]{1,12}$/.test(x)))].slice(0, 12)
  : [];

export interface NewsItem {
  id: string | null; headline: string; source: string; url: string; symbols: string[];
  published_at: string; updated_at: string | null; first_seen_at: string;
}
interface Stored { received_at: number; feed_at: string; items: NewsItem[]; }

export function clean(payload: unknown, receivedAt = Date.now()): Stored {
  const p = obj(payload);
  const rows = Array.isArray(p.items) ? p.items : [];
  const items = rows.slice(0, MAX_ITEMS).map(obj).map((row): NewsItem | null => {
    const headline = text(row.headline, 300), source = text(row.source, 80), url = link(row.url);
    const published_at = instant(row.published_at), first_seen_at = instant(row.first_seen_at), tagged = symbols(row.symbols);
    if (!headline || !source || !url || !published_at || !first_seen_at || !tagged.length) return null;
    if (Date.parse(published_at) > receivedAt + MAX_CLOCK_SKEW_MS || Date.parse(first_seen_at) > receivedAt + MAX_CLOCK_SKEW_MS) return null;
    return { id: text(row.id, 100), headline, source, url, symbols: tagged,
      published_at, updated_at: instant(row.updated_at), first_seen_at };
  }).filter((x): x is NewsItem => !!x).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return { received_at: receivedAt, feed_at: instant(p.feed_at) ?? new Date(receivedAt).toISOString(), items };
}

export async function receive(env: Env & { RADAR_TOKEN?: string }, request: Request) {
  const expected = env.RADAR_TOKEN;
  if (!expected) throw new HubError(503, "news_not_set_up", "The Hub has no watcher token, so it is not accepting news yet.");
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, expected)) throw new HubError(401, "bad_news_token", "That token does not match the watcher token.");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new HubError(413, "news_too_big", "That news update is larger than the Hub accepts.");
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw new HubError(400, "news_not_json", "That news update was not readable JSON."); }
  const stored = clean(payload);
  await db.setSetting(env, STORE_KEY, JSON.stringify(stored));
  return stored;
}

export async function current(env: Env) {
  const raw = await db.getSetting(env, STORE_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (!Number.isFinite(stored.received_at) || !Array.isArray(stored.items)) return null;
    const age_minutes = Math.max(0, Math.floor((Date.now() - stored.received_at) / 60_000));
    return { ...stored, age_minutes, stale: Date.now() - stored.received_at > STALE_AFTER_MS };
  } catch { return null; }
}
