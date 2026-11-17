// The live radar: what Casey's watcher is seeing in the market right now.
//
// The watcher writes a dashboard file every scan. Two ways it reaches the hub:
//   1. the watcher posts it here after each scan, which is live (needs RADAR_TOKEN);
//   2. otherwise the hub reads the copy published with the nightly lab results.
// Whichever is newer wins, and the hub always says how old the numbers are.
//
// This answers one question: is there anything worth looking at today? Most of the
// time the honest answer is no, and the panel says so rather than finding something.

import * as db from "./db";
import { type Actor, type Env, HubError, requireScope, safeEqual } from "./util";

export const RADAR_URL = "https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/dashboard.json";
const STORE_KEY = "radar_latest";
const PUBLISHED_KEY = "radar_published";
const FRESH_FOR_MS = 5 * 60_000; // don't re-read the published copy more than this often
const STALE_AFTER_MINUTES = 30; // a live radar older than this is not "now" any more
const MAX_CANDIDATES = 25;
const MAX_LOG = 15;
export const MAX_BODY_BYTES = 512 * 1024;

const str = (v: unknown, max = 400): string | null => (typeof v === "string" && v ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * When a headline could first have been acted on, and whether that is even knowable.
 * A story published before the scan is not the same as one the pipeline had in hand:
 * availability is the later of publication and first sighting, and a headline stamped
 * after the scan that carries it cannot have informed anything in that scan.
 */
function newsTiming(published: string | null, firstSeen: string | null, scanAt: string | null) {
  const pub = published ? Date.parse(published) : NaN;
  const seen = firstSeen ? Date.parse(firstSeen) : NaN;
  const scan = scanAt ? Date.parse(scanAt) : NaN;
  if (!Number.isFinite(pub) && !Number.isFinite(seen)) return { verdict: "UNKNOWN_TIME" as const, available_at: null, basis: "No readable time came with this headline." };
  const availableMs = Math.max(Number.isFinite(pub) ? pub : -Infinity, Number.isFinite(seen) ? seen : -Infinity);
  const available_at = new Date(availableMs).toISOString();
  if (Number.isFinite(scan) && availableMs > scan) {
    return { verdict: "FAIL_FUTURE_INFORMATION" as const, available_at, basis: "This headline is stamped after the scan that carries it, so it cannot have informed it." };
  }
  if (!Number.isFinite(seen)) {
    return { verdict: "UNKNOWN_INGESTION" as const, available_at, basis: "Publication time only. When the watcher actually saw it was not recorded, so treat availability as a guess." };
  }
  return { verdict: "ok" as const, available_at, basis: "Available from the later of publication and first sighting." };
}

/** Only these fields are kept, whatever else arrives. Nothing about an account travels. */
function candidate(raw: unknown, scanAt: string | null) {
  const c = obj(raw);
  const published = str(c.news_time, 60);
  const firstSeen = str(c.news_first_seen, 60);
  return {
    symbol: str(c.symbol, 20),
    price: num(c.price),
    spread_pct: num(c.spread_pct),
    day_move_pct: num(c.day_move_pct),
    relative_volume: num(c.relative_volume),
    rsi: num(c.rsi),
    vwap: num(c.vwap),
    breakout_level: num(c.breakout_level),
    technical_stop: num(c.technical_stop),
    stage: str(c.stage, 80),
    confirmation: str(c.confirmation, 120),
    setup: str(c.setup, 120),
    market_context: str(c.market_context, 200),
    score: num(c.score),
    news: {
      headline: str(c.news_headline, 300),
      published_at: published,
      first_seen_at: firstSeen,
      url: str(c.news_url, 500),
      ...newsTiming(published, firstSeen, scanAt),
    },
    checks: {
      halt: str(c.halt_check, 120),
      sec: str(c.sec_check, 120),
      risk_sources: arr(c.risk_sources).map((s) => str(s, 200)).filter(Boolean).slice(0, 6),
    },
    attention: {
      messages_1h: num(c.stocktwits_message_count_1h),
      bullish_pct: num(c.stocktwits_bullish_pct),
      note: "Social attention, never a catalyst or a reason on its own.",
    },
  };
}

export interface Radar {
  generated_at: string | null;
  market: { phase: string | null; is_open: boolean | null; next_open: string | null; next_close: string | null };
  sources: { market_data: string | null; sec_edgar: string | null; halts: string | null; social: string | null };
  note: string | null;
  candidate_count: number;
  candidates: ReturnType<typeof candidate>[];
  research_log: { time: string | null; text: string | null }[];
  gates: { label: string | null; rule: string | null }[];
  arrived_via: "posted by the watcher" | "published with the nightly lab run";
}

export function clean(raw: unknown, via: Radar["arrived_via"]): Radar {
  const d = obj(raw);
  const m = obj(d.market);
  const sys = obj(d.system);
  const all = arr(d.candidates);
  return {
    generated_at: str(d.generated_at, 60),
    market: { phase: str(m.phase, 60), is_open: bool(m.is_open), next_open: str(m.next_open, 60), next_close: str(m.next_close, 60) },
    sources: {
      market_data: str(sys.market_data, 80),
      sec_edgar: str(sys.sec_edgar, 80),
      halts: str(sys.nasdaq_halts, 80),
      social: str(sys.stocktwits, 80),
    },
    note: str(sys.note, 400),
    candidate_count: all.length,
    candidates: all.slice(0, MAX_CANDIDATES).map((c) => candidate(c, str(d.generated_at, 60))).filter((c) => c.symbol),
    research_log: arr(d.research_log)
      .slice(0, MAX_LOG)
      .map((r) => {
        const o = obj(r);
        return { time: str(o.time, 60), text: str(o.headline ?? o.text ?? o.note, 300) };
      })
      .filter((r) => r.text),
    gates: arr(d.gates)
      .slice(0, 20)
      .map((g) => ({ label: str(obj(g).label, 60), rule: str(obj(g).rule, 120) }))
      .filter((g) => g.label),
    arrived_via: via,
  };
}

interface Stored {
  stored_at: number;
  radar: Radar;
}

const parse = (raw: string | null): Stored | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
};

/** The watcher posting a fresh scan. Rejected unless RADAR_TOKEN is set and matches. */
export async function receive(env: Env & { RADAR_TOKEN?: string }, request: Request): Promise<Radar> {
  const expected = env.RADAR_TOKEN;
  if (!expected) {
    throw new HubError(503, "radar_not_set_up", "The hub has no RADAR_TOKEN, so it is not accepting live radar scans yet.");
  }
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, expected)) throw new HubError(401, "bad_radar_token", "That token does not match the hub's RADAR_TOKEN.");
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) throw new HubError(413, "radar_too_big", "That scan is larger than the hub accepts.");
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new HubError(400, "radar_not_json", "That scan was not readable JSON.");
  }
  const radar = clean(payload, "posted by the watcher");
  await db.setSetting(env, STORE_KEY, JSON.stringify({ stored_at: Date.now(), radar } satisfies Stored));
  return radar;
}

async function readPublished(env: Env, now: number): Promise<Stored | null> {
  const cached = parse(await db.getSetting(env, PUBLISHED_KEY));
  if (cached && now - cached.stored_at < FRESH_FOR_MS) return cached;
  try {
    const res = await fetch(RADAR_URL, { headers: { accept: "application/json" } });
    if (!res.ok) return cached;
    const fresh: Stored = { stored_at: now, radar: clean(await res.json(), "published with the nightly lab run") };
    await db.setSetting(env, PUBLISHED_KEY, JSON.stringify(fresh));
    return fresh;
  } catch (error) {
    console.error("radar fetch failed", String(error));
    return cached;
  }
}

const ageMinutes = (radar: Radar, now: number): number | null => {
  const ms = radar.generated_at ? Date.parse(radar.generated_at) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.round((now - ms) / 60_000)) : null;
};

/** The most recent scan the hub has, from whichever route is newer, with its age. */
export async function current(env: Env) {
  const now = Date.now();
  const [posted, published] = await Promise.all([
    Promise.resolve(parse(await db.getSetting(env, STORE_KEY))),
    readPublished(env, now),
  ]);
  // Rank by when the watcher made the scan. A copy with no timestamp at all cannot
  // be called newer than one that has a real time on it, whenever the hub read it.
  const stamp = (s: Stored) => {
    const ms = Date.parse(s.radar.generated_at ?? "");
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  const pick = [posted, published].filter((s): s is Stored => !!s).sort((a, b) => stamp(b) - stamp(a))[0];
  if (stamp(pick) === Number.NEGATIVE_INFINITY) return null;
  if (!pick) return null;
  const age = ageMinutes(pick.radar, now);
  return {
    ...pick.radar,
    age_minutes: age,
    stale: age === null || age > STALE_AFTER_MINUTES,
    live_feed_connected: !!posted && now - posted.stored_at < 2 * 60 * 60_000,
  };
}

export async function forAgent(env: Env, actor: Actor) {
  requireScope(actor, "hub:read");
  const radar = await current(env);
  if (!radar) throw new HubError(503, "radar_unavailable", "The hub has not received a radar scan yet.");
  return {
    ...radar,
    how_to_use:
"Each headline carries a timing verdict. Only \"ok\" means it was both published and seen before the scan; UNKNOWN_INGESTION means publication time only, so availability is a guess; FAIL_FUTURE_INFORMATION means it is stamped after the scan and cannot have informed it. Never use a headline that is not \"ok\" as evidence that a setup had a catalyst. This is what the watcher saw at generated_at, not now. An empty candidate list means nothing passed Casey's gates at that moment, which is the usual and correct outcome; do not treat it as a reason to loosen anything. A headline here is a timestamped observation, not a verified catalyst, and attention numbers are never a reason on their own. Check age_minutes before relying on any of it, and never present this as permission to trade.",
  };
}
