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
 * A time is only usable if it says which time it is. Date.parse accepts a bare
 * "2026-11-17T18:00:00" and quietly reads it in the runtime's own zone, which turns
 * an unanswerable question into a confident wrong answer. Require an explicit offset.
 */
function instant(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
  const ms = Date.parse(value.trim().replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When a headline could first have been acted on, and whether that is even knowable.
 * A story published before the scan is not the same as one the pipeline had in hand:
 * availability is the later of publication and first sighting.
 *
 * A scan is not an instant. The watcher fixes its decision clock (generated_at) before
 * it reads anything, then spends real seconds fetching, and publishes at the end
 * (published_at). A headline the scan fetches for itself is stamped inside that window,
 * so it is legitimately later than generated_at. Comparing a sighting against the start
 * of the window would accuse every real headline of arriving from the future.
 *
 * So the comparison is against the END of the window. Without it we cannot tell a
 * headline gathered mid-scan from one backfilled afterwards, and we say so rather than
 * guessing in either direction.
 *
 * This fails closed in both directions. Anything missing, unzoned or unreadable is
 * UNKNOWN, never "ok", because "ok" is read elsewhere as proof that a candidate had a
 * catalyst in time; and never FAIL, because that is read as proof it could not have.
 */
function newsTiming(published: string | null, firstSeen: string | null, scanAt: string | null, publishedAt: string | null, seenVia: string | null) {
  const pub = instant(published);
  const seen = instant(firstSeen);
  const scan = instant(scanAt);
  const done = instant(publishedAt);
  const unknown = (basis: string) => ({ verdict: "UNKNOWN_TIME" as const, available_at: null, basis });

  if (pub === null && seen === null) return unknown("No readable, time-zoned time came with this headline.");
  // A sighting alone cannot be checked against publication, and publication alone
  // cannot be checked against when the watcher actually had it. Neither is proof.
  if (pub === null) return unknown("This headline has a sighting time but no readable publication time, so when it became news is unknown.");
  if (scan === null) return unknown("The scan carrying this headline has no readable time, so nothing can be compared against it.");

  const availableMs = seen === null ? pub : Math.max(pub, seen);
  const available_at = new Date(availableMs).toISOString();

  // Two facts, two different bounds.
  //
  // Publication is bounded by the DECISION clock. The scanner asks for news in the window
  // ending at that clock, so a headline published after it cannot have come through the
  // gate at all. That is a real impossibility, and it is named as one.
  if (pub > scan) {
    return { verdict: "FAIL_FUTURE_INFORMATION" as const, available_at, basis: "This headline was published after the scan's decision time, so the scan cannot have had it." };
  }

  // The sighting is bounded by the END of the scan, because the fetch happens partway
  // through. A completion time earlier than the decision time is a broken pair we do not
  // trust to widen anything.
  const windowKnown = done !== null && done >= scan;
  const windowEnd = windowKnown ? (done as number) : scan;
  if (seen !== null && seen > windowEnd) {
    if (!windowKnown) {
      // Mid-scan fetch and later backfill are indistinguishable here. Saying so is not a
      // weaker guard than accusing: only "ok" lets a headline count as a catalyst, and
      // this is not "ok". It just stops the hub asserting something it cannot know.
      return { verdict: "UNKNOWN_SCAN_WINDOW" as const, available_at, basis: "The watcher saw this headline after the scan's decision time, and the scan did not report when it finished. A headline fetched during the scan looks exactly like one backfilled after it, so this cannot be resolved." };
    }
    return { verdict: "FAIL_FUTURE_INFORMATION" as const, available_at, basis: "The watcher did not have this headline until after the scan had finished, so it cannot have informed it." };
  }
  if (seen === null) {
    return { verdict: "UNKNOWN_INGESTION" as const, available_at, basis: "Publication time only. When the watcher actually saw it was not recorded, so treat availability as a guess." };
  }
  // "ok" only ever means the headline cannot have come from after the scan. How the watcher
  // got it decides how much more it means. A live sighting shows the watcher held the
  // headline for some time first. A fetch made by the scan itself shows only that: the
  // scan had it, which says nothing about whether it was there early enough to act on.
  // Whether the watcher had this headline before the scan STARTED is a stronger fact
  // than having it before the scan finished, and only one of them is usually true.
  // ChatGPT caught the live_stream line claiming the strong one on the weak evidence.
  const beforeStart = seen <= scan;
  if (seenVia === "scan_fetch") {
    return { verdict: "ok" as const, available_at, basis: "Published before the scan, and the scan fetched it itself" + (beforeStart ? " before its decision time" : " partway through") + ". That rules out a headline from after the scan. It does not show the headline was available early enough to act on." };
  }
  if (seenVia === "live_stream") {
    return beforeStart
      ? { verdict: "ok" as const, available_at, basis: "Published, then seen live by the watcher, both before the scan started. The watcher held this headline going into the scan." }
      : { verdict: "ok" as const, available_at, basis: "Published, then seen live by the watcher, but not until after the scan had started. It was in hand before the scan finished, not before it began, so it cannot show the news preceded the setup." };
  }
  return { verdict: "ok" as const, available_at, basis: "Published, and first seen before the scan " + (beforeStart ? "started" : "finished") + ". How the watcher got it was not recorded." };
}

/** Only these fields are kept, whatever else arrives. Nothing about an account travels. */
function candidate(raw: unknown, scanAt: string | null, publishedAt: string | null) {
  const c = obj(raw);
  const published = str(c.news_time, 60);
  const firstSeen = str(c.news_first_seen, 60);
  const seenVia = str(c.news_seen_via, 20);
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
      seen_via: seenVia,
      url: str(c.news_url, 500),
      ...newsTiming(published, firstSeen, scanAt, publishedAt, seenVia),
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

/** One ticker row.
 *
 *  `age_seconds` here is only the age AT INGESTION. clean()'s output is stored, so this
 *  number is frozen the moment it is written. current() recomputes it from `at` on every
 *  read, and that is the only value an agent ever sees. ChatGPT caught me shipping this
 *  with a comment claiming read-time freshness while the value was in fact cached: a
 *  cached scan would have kept reporting a fresh-looking quote age forever. */
function quote(raw: unknown) {
  const q = obj(raw);
  const at = str(q.at, 60);
  // instant(), not Date.parse(). Date.parse accepts an unzoned string and reads it in
  // the runtime's own zone, which is the exact bug ChatGPT found in the headline timing
  // check. A price stamped "18:29:00" with no offset is not a stamp.
  const ms = instant(at);
  const price = num(q.price);
  // A row is only usable if the watcher said so AND a price actually came with it.
  // Trusting the flag alone would let a null price through as though it were real.
  const usable = q.available === true && price !== null;
  return {
    symbol: str(q.symbol, 20),
    price,
    change_pct: num(q.change_pct),
    at,
    age_seconds: ms === null ? null : Math.max(0, Math.round((Date.now() - ms) / 1000)),
    available: usable,
    note: usable ? null : "The feed did not return this symbol on the last scan. No price is shown rather than an old one.",
  };
}

export interface Radar {
  generated_at: string | null;
  published_at: string | null;
  market: { phase: string | null; is_open: boolean | null; next_open: string | null; next_close: string | null };
  sources: { market_data: string | null; sec_edgar: string | null; halts: string | null; social: string | null };
  note: string | null;
  candidate_count: number;
  candidates: ReturnType<typeof candidate>[];
  quotes: ReturnType<typeof quote>[];
  research_log: { time: string | null; text: string | null }[];
  gates: { label: string | null; rule: string | null }[];
  arrived_via: "posted by the watcher" | "published with the nightly lab run";
}

function gate(raw: unknown) {
  const g = obj(raw);
  const label = str(g.label, 60);
  const rule = str(g.rule, 120);
  // A scan-time REST lookup proves that a recent headline was found, not that
  // the watcher held it before the setup formed. Keep the producer's gate but
  // do not repeat its legacy overclaim in Casey's Hub.
  const legacyCatalyst = /^catalyst:\s*verified news within 24 hours$/i;
  return {
    label: label && legacyCatalyst.test(label) ? "Recent headline: published within 24 hours" : label,
    rule: rule?.replace(/verified news/gi, "a headline published in the scan lookback") ?? null,
  };
}

export function clean(raw: unknown, via: Radar["arrived_via"]): Radar {
  const d = obj(raw);
  const m = obj(d.market);
  const sys = obj(d.system);
  const all = arr(d.candidates);
  return {
    generated_at: str(d.generated_at, 60),
    published_at: str(d.published_at, 60),
    quotes: arr(d.quotes).slice(0, 12).map(quote).filter((q) => q.symbol),
    market: { phase: str(m.phase, 60), is_open: bool(m.is_open), next_open: str(m.next_open, 60), next_close: str(m.next_close, 60) },
    sources: {
      market_data: str(sys.market_data, 80),
      sec_edgar: str(sys.sec_edgar, 80),
      halts: str(sys.nasdaq_halts, 80),
      social: str(sys.stocktwits, 80),
    },
    note: str(sys.note, 400),
    candidate_count: all.length,
    candidates: all.slice(0, MAX_CANDIDATES).map((c) => candidate(c, str(d.generated_at, 60), str(d.published_at, 60))).filter((c) => c.symbol),
    research_log: arr(d.research_log)
      .slice(0, MAX_LOG)
      .map((r) => {
        const o = obj(r);
        return { time: str(o.time, 60), text: str(o.headline ?? o.text ?? o.note, 300) };
      })
      .filter((r) => r.text),
    gates: arr(d.gates)
      .slice(0, 20)
      .map(gate)
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
    // Re-aged from each quote's own unchanged timestamp, never from the stored age, and
    // never from when the hub happened to receive the scan. An unreadable or missing
    // time stays unknown rather than being given a number.
    quotes: (pick.radar.quotes ?? []).map((q) => {
      const ms = instant(q.at);
      return { ...q, age_seconds: ms === null ? null : Math.max(0, Math.round((now - ms) / 1000)) };
    }),
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
"Each headline carries a timing verdict and a basis line saying what it rests on. Read the basis, not just the verdict: \"ok\" means only that the headline cannot have come from after the scan. Where seen_via is scan_fetch the scan fetched the headline itself, so nothing shows it was available early enough to act on; where it is live_stream the watcher saw it on the live feed, and the basis says whether that was before the scan started or only before it finished. Only the first shows the news preceded the setup. UNKNOWN_INGESTION means publication time only, so availability is a guess; UNKNOWN_SCAN_WINDOW means the headline is stamped after the scan's decision time and the scan did not report when it finished, so a mid-scan fetch cannot be told apart from a later backfill; FAIL_FUTURE_INFORMATION means it arrived after the scan had finished and cannot have informed it. Never use a headline that is not \"ok\" as evidence that a setup had a catalyst. This is what the watcher saw at generated_at, not now. An empty candidate list means nothing passed Casey's gates at that moment, which is the usual and correct outcome; do not treat it as a reason to loosen anything. A headline here is a timestamped observation, not a verified catalyst, and attention numbers are never a reason on their own. Check age_minutes before relying on any of it, and never present this as permission to trade.",
  };
}
