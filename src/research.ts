// Casey's own breakout lab, brought into the hub.
//
// The lab lives in his watcher project and publishes its results as a public
// file. The hub reads that file, boils it down to the handful of things worth
// acting on, and keeps the boiled-down version so the page stays quick.
//
// This is research, not a signal. The hub still cannot place an order, and the
// lab's findings are evidence to weigh, never an instruction.

import * as db from "./db";
import { type Actor, type Env, HubError, requireScope } from "./util";

// The lab itself runs in Casey's private watcher repo and copies its result into the
// public one. The raw file updates the moment that copy lands; the Pages copy only
// updates when a site deploy runs, so it is the fallback rather than the first choice.
export const LAB_URL = "https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/backtest.json";
export const LAB_URL_FALLBACK = "https://caseycbar-sudo.github.io/Alpaca-breakout-watcher/data/backtest.json";
export const HISTORY_URL = "https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/backtest_history.json";
export const SWING_RESULTS_URL = "https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/swing_lab.json";
export const SWING_SIGNAL_URL = "https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/swing_signal.json";
const CACHE_KEY = "research_summary";
const FRESH_FOR_MS = 60 * 60_000; // re-read the lab at most once an hour
const STALE_AFTER_DAYS = 14; // after this, say plainly that the lab has not run

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const round = (v: number | null, places = 2): number | null => (v === null ? null : Math.round(v * 10 ** places) / 10 ** places);

export interface Run {
  trades: number | null;
  win_rate: number | null;
  avg_r: number | null;
  profit_factor: number | null;
  net_pl?: number | null;
}

function run(raw: unknown): Run {
  const r = obj(raw);
  return {
    trades: num(r.trades),
    win_rate: round(num(r.win_rate), 1),
    avg_r: round(num(r.avg_r)),
    profit_factor: round(num(r.profit_factor)),
    ...(num(r.net_pl) === null ? {} : { net_pl: round(num(r.net_pl)) }),
  };
}

/** One sentence a person can act on, built only from what the lab actually reported. */
function headline(loose: Run, strict: Run, validated: boolean, days: number | null): string {
  if (validated) return "The lab says its rules have been validated. Read the detail before relying on it.";
  const parts: string[] = [];
  if (loose.trades !== null && loose.avg_r !== null) {
    parts.push(
      loose.avg_r < 0
        ? `Taking every signal lost money across ${loose.trades} trades (average ${loose.avg_r}R a trade).`
        : `Taking every signal made ${loose.avg_r}R a trade across ${loose.trades} trades.`,
    );
  }
  if (strict.trades !== null) {
    parts.push(
      strict.trades < 10
        ? `The strict rules almost never fire: ${strict.trades} ${strict.trades === 1 ? "trade" : "trades"}${days ? ` in ${days} trading days` : ""}, too few to judge.`
        : `The strict rules fired ${strict.trades} times, averaging ${strict.avg_r}R.`,
    );
  }
  parts.push("No edge is proven yet, so treat any plan as an experiment rather than a signal.");
  return parts.join(" ");
}

/** Producer-selected patterns; selection does not establish unseen validation. */
function patternList(raw: unknown, limit: number) {
  return arr(raw)
    .slice(0, limit)
    .map((p) => {
      const o = obj(p);
      const test = obj(o.test);
      const unseen = obj(o.unseen);
      return {
        pattern: str(o.pattern) || str(o.bucket) || "unnamed",
        verdict: str(o.verdict) || null,
        evidence: str(o.evidence) || null,
        trades_checked: num(test.n),
        avg_r: round(num(test.avg_r)),
        win_rate: round(num(test.win_rate), 1),
        unseen_result: str(o.unseen_result) || null,
        unseen: { trades: num(unseen.n), avg_r: round(num(unseen.avg_r)), win_rate: round(num(unseen.win_rate), 1) },
      };
    })
    .filter((p) => p.pattern !== "unnamed");
}

/** Hours of the session, worst first removed: which part of the day held up best. */
function timeOfDay(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      return { bucket: str(o.bucket), trades: num(o.trades), win_rate: round(num(o.win_rate), 1), avg_r: round(num(o.avg_r)), target_rate: round(num(o.target_rate), 1) };
    })
    .filter((x) => x.bucket && x.trades);
}

// Conditions the lab measures from the entry bar's own close, or a later bar. The
// backtest enters at that bar's OPEN and starts simulating the exit on that same
// bar, so none of these is known when the decision is made. They describe how a
// trade went, not how to pick one, and a trade stopped out on the entry bar will
// almost always show up on the wrong side of them. Checked against the producer:
// src/backtest.py builds them from second_bar (index i+1) and the bar after it.
const AFTER_ENTRY = new Set(["held_breakout", "second_bar_green", "next_candle_green", "successful_retest"]);

/** Conditions where having the thing and not having it gave clearly different results. */
function swings(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      const yes = obj(o.yes);
      const no = obj(o.no);
      const a = num(yes.avg_r);
      const b = num(no.avg_r);
      const key = str(o.key);
      return {
        label: str(o.label) || key,
        knowable_at_entry: !AFTER_ENTRY.has(key),
        with_it: { trades: num(yes.trades), win_rate: round(num(yes.win_rate), 1), avg_r: round(a) },
        without_it: { trades: num(no.trades), win_rate: round(num(no.win_rate), 1), avg_r: round(b) },
        difference_r: a === null || b === null ? null : round(a - b),
      };
    })
    .filter((x) => x.label && x.difference_r !== null)
    .sort((x, y) => Math.abs(y.difference_r as number) - Math.abs(x.difference_r as number));
}

function outcomes(raw: unknown) {
  const rows = arr(raw).map((x) => {
    const o = obj(x);
    return { label: str(o.label) || str(o.reason), trades: num(o.trades), avg_r: round(num(o.avg_r)) };
  }).filter((x) => x.label && x.trades);
  const total = rows.reduce((sum, r) => sum + (r.trades ?? 0), 0);
  return rows.map((r) => ({ ...r, share_pct: total ? round(((r.trades as number) / total) * 100, 1) : null }));
}

function targetSweep(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      return { target_pct: num(o.target_pct), trades: num(o.trades), win_rate: round(num(o.win_rate), 1), avg_r: round(num(o.avg_r)), target_hit_rate: round(num(o.target_hit_rate), 1) };
    })
    .filter((x) => x.target_pct !== null);
}

/** The stop-width experiment. Dollars lead, because R is defined by the stop:
 *  widen it and every R shrinks toward zero whether or not a trade went better.
 *  Both are carried so the hub can show that they disagree, which is the point. */
function stopSweep(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      return {
        stop_pct: num(o.stop_pct),
        target_pct: num(o.target_pct),
        trades: num(o.trades),
        win_rate: round(num(o.win_rate), 1),
        avg_r: round(num(o.avg_r), 3),
        stopped_out_rate: round(num(o.stopped_out_rate), 1),
        target_hit_rate: round(num(o.target_hit_rate), 1),
        avg_dollars: round(num(o.avg_dollars), 3),
        total_dollars: round(num(o.total_dollars), 2),
      };
    })
    .filter((x) => x.stop_pct !== null && x.avg_dollars !== null);
}

function dayShape(raw: unknown) {
  const d = obj(raw);
  const day = (v: unknown) => {
    const o = obj(v);
    return o.date ? { date: str(o.date), trades: num(o.trades), total_r: round(num(o.total_r)) } : null;
  };
  return {
    trading_days: num(d.trading_days),
    green_days: num(d.green_days),
    red_days: num(d.red_days),
    green_day_rate: round(num(d.green_day_rate), 1),
    average_day_r: round(num(d.average_day_r)),
    best_day: day(d.best_day),
    worst_day: day(d.worst_day),
  };
}

function factors(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      return { factor: str(o.factor), effect: str(o.effect), weight: round(num(o.weight), 3) };
    })
    .filter((f) => f.factor)
    .slice(0, 8);
}

/** Casey's own entry gates, and whether the trades that passed them actually did better. */
function gates(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      const passed = obj(o.passed);
      const failed = obj(o.failed);
      return {
        gate: str(o.gate),
        verdict: str(o.verdict) || null,
        passed: { trades: num(passed.n), avg_r: round(num(passed.avg_r)) },
        failed: { trades: num(failed.n), avg_r: round(num(failed.avg_r)) },
      };
    })
    .filter((g) => g.gate);
}

/** Symbols with enough trades to say anything, best first. */
function symbols(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      const l = obj(o.learning);
      return {
        symbol: str(o.symbol),
        trades: num(l.trades),
        win_rate: round(num(l.win_rate), 1),
        avg_r: round(num(l.avg_r)),
        follow_through: str(o.note) || null,
      };
    })
    .filter((t) => t.symbol && (t.trades ?? 0) >= 10 && t.avg_r !== null)
    .sort((a, b) => (b.avg_r as number) - (a.avg_r as number))
    .slice(0, 10);
}

/** How the lab's own conclusions have moved from run to run. */
export function trend(raw: unknown) {
  const rows = arr(raw)
    .map((x) => {
      const o = obj(x);
      return {
        at: str(o.generated_at).slice(0, 10),
        trades: num(o.learning_trades),
        avg_r: round(num(o.learning_avg_r)),
        model_test_auc: round(num(o.model_test_auc), 3),
        promising: arr(o.promising).map(str).filter(Boolean),
        avoid_count: arr(o.avoid).length,
      };
    })
    .filter((r) => r.at);

  // One point per lab run date, keeping the last. The lab can run several times in a
  // day, and today it ran three times with identical numbers. Left in, those repeats
  // flatten the tail of the trend line and make the most recent day look like three
  // days of agreement, which is the opposite of what a steadiness chart is for.
  const oncePerDay: typeof rows = [];
  for (const row of rows) {
    const last = oncePerDay[oncePerDay.length - 1];
    if (last && last.at === row.at) oncePerDay[oncePerDay.length - 1] = row;
    else oncePerDay.push(row);
  }
  return oncePerDay.slice(-20);
}

// The second lab. Twenty years of daily bars with real costs, testing slow and
// well-known strategies rather than intraday breakouts. Its two live rules are
// simple trend filters, so a nightly reading is as current as they ever need to be.
export function strategies(raw: unknown) {
  return arr(raw)
    .map((x) => {
      const o = obj(x);
      return {
        name: str(o.name),
        since: str(o.start) || null,
        cagr: round(num(o.cagr), 1),
        worst_drawdown: round(num(o.maxdd), 1),
        sharpe: round(num(o.sharpe), 2),
        trades_per_year: round(num(o.trades_per_yr), 1),
        last_3_years: round(num(o.last3y), 1),
      };
    })
    .filter((x) => x.name && x.cagr !== null)
    .sort((a, b) => (b.sharpe ?? -99) - (a.sharpe ?? -99))
    .slice(0, 20);
}

export function sleeves(raw: unknown) {
  const d = obj(raw);
  return {
    read_at: str(d.generated_at) || null,
    sleeves: arr(d.sleeves)
      .map((x) => {
        const o = obj(x);
        const signal = str(o.signal).toUpperCase();
        return {
          symbol: str(o.symbol).slice(0, 20),
          rule: num(o.length) === null ? null : `hold while above its ${o.length}-day average`,
          as_of: str(o.as_of).slice(0, 20) || null,
          close: round(num(o.close)),
          average: round(num(o.average)),
          distance_pct: round(num(o.distance_pct), 2),
          signal: signal === "HOLD" || signal === "CASH" ? signal : null,
        };
      })
      .filter((x) => x.symbol && x.signal),
  };
}

export interface Summary {
  source: string;
  generated_at: string | null;
  age_days: number | null;
  stale: boolean;
  window: { start: string | null; end: string | null; trading_days: number | null };
  headline: string;
  every_signal: Run;
  strict_rules: Run;
  model: { status: string | null; verdict: string | null };
  stay_away_from: ReturnType<typeof patternList>;
  held_up: ReturnType<typeof patternList>;
  best_times: ReturnType<typeof timeOfDay>;
  what_moves_the_odds: ReturnType<typeof swings>;
  lookahead_warning: string | null;
  how_trades_ended: ReturnType<typeof outcomes>;
  target_sweep: ReturnType<typeof targetSweep>;
  stop_sweep: ReturnType<typeof stopSweep>;
  day_shape: ReturnType<typeof dayShape>;
  model_factors: ReturnType<typeof factors>;
  your_gates: ReturnType<typeof gates>;
  symbols: ReturnType<typeof symbols>;
  assumptions: { entry: string | null; exit: string | null; spread_pct: number | null; slippage_pct: number | null; reward_to_risk: number | null };
  symbols_studied: number | null;
  caveats: string[];
  trend: ReturnType<typeof trend>;
  swing: { strategies: ReturnType<typeof strategies>; signals: ReturnType<typeof sleeves> | null; problem: string | null } | null;
  caveat: string;
}

function ageFields(generated: string | null, now: number) {
  const ms = generated ? Date.parse(generated) : NaN;
  const age_days = Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 86_400_000)) : null;
  return { age_days, stale: age_days === null || age_days > STALE_AFTER_DAYS };
}

export function summarize(raw: unknown, now = Date.now()): Summary {
  const d = obj(raw);
  const summary = obj(d.summary);
  const patterns = obj(d.patterns);
  const w = obj(d.window);
  const analytics = obj(d.analytics);
  const assume = obj(d.assumptions);
  const generated = str(d.generated_at) || null;
  const loose = run(summary.learning);
  const strict = run(summary.strict_setups);
  const trading = num(w.trading_days);
  const whatMoved = swings(analytics.follow_through).slice(0, 6);
  return {
    source: LAB_URL,
    generated_at: generated,
    ...ageFields(generated, now),
    window: { start: str(w.start) || null, end: str(w.end) || null, trading_days: trading },
    headline: headline(loose, strict, summary.validated === true, trading),
    every_signal: loose,
    strict_rules: strict,
    model: { status: str(obj(d.model).status) || null, verdict: str(obj(d.model).verdict) || null },
    stay_away_from: patternList(patterns.avoid, 8),
    held_up: patternList(patterns.promising, 8),
    best_times: timeOfDay(analytics.time_of_day),
    what_moves_the_odds: whatMoved,
    lookahead_warning: whatMoved.some((x) => !x.knowable_at_entry)
      ? "Some of these are measured from the entry bar's own close or a later bar. The backtest enters at that bar's open and starts the exit on the same bar, so they are not known when the decision is made. A trade stopped out on the entry bar lands on the losing side of them almost by definition. Read them as how a trade went, never as a filter for picking one."
      : null,
    how_trades_ended: outcomes(analytics.outcomes),
    target_sweep: targetSweep(analytics.target_sweep),
    stop_sweep: stopSweep(analytics.stop_pct_sweep),
    day_shape: dayShape(analytics.days),
    model_factors: factors(obj(d.model).factors),
    your_gates: gates(patterns.gate_review),
    symbols: symbols(d.tickers),
    assumptions: {
      entry: str(assume.entry) || null,
      exit: str(assume.exit) || null,
      spread_pct: num(assume.modeled_spread_pct),
      slippage_pct: num(assume.slippage_pct),
      reward_to_risk: num(assume.reward_to_risk),
    },
    symbols_studied: arr(d.study_list).length || null,
    caveats: arr(d.caveats).map(str).filter(Boolean).slice(0, 8),
    trend: [],
    swing: null,
    caveat:
      "These are backtested results from Casey's own lab, with modeled spread and slippage. They describe what the rules would have done, not what any trade will do. The hub cannot place orders, and nothing here is advice.",
  };
}

interface Cached {
  fetched_at: number;
  summary?: Summary;
  problem?: string;
}

/** A lab file, with "never published" kept distinct from "published but unreadable".
 *
 *  Those two look identical on the page if both just return null, and that is exactly
 *  how the whole swing lab stayed invisible: the producer wrote Infinity, which Python
 *  reads back happily and JSON.parse rejects outright, the error went to a console
 *  nobody reads, and the hub rendered an empty section as though the lab had simply
 *  not run. A file we cannot read is a fault to report, not an absence to render. */
async function readJson(url: string): Promise<{ data: unknown | null; problem: string | null }> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { data: null, problem: `The lab file could not be fetched (${res.status}).` };
    const text = await res.text();
    try {
      return { data: JSON.parse(text), problem: null };
    } catch {
      const bad = /\b(Infinity|-Infinity|NaN)\b/.test(text) ? " It contains Infinity or NaN, which is not valid JSON." : "";
      return { data: null, problem: `The lab published a file this hub cannot read.${bad} The numbers below are missing for that reason, not because the lab found nothing.` };
    }
  } catch (error) {
    console.error("lab file fetch failed", url, String(error));
    return { data: null, problem: "The lab file could not be fetched." };
  }
}

/** The swing lab's table and its two trend readings, if they have been published. */
export const readSwingForTest = () => readSwing();

async function readSwing(): Promise<Summary["swing"]> {
  const [results, signal] = await Promise.all([readJson(SWING_RESULTS_URL), readJson(SWING_SIGNAL_URL)]);
  const problem = results.problem ?? signal.problem ?? null;
  if (!results.data && !signal.data && !problem) return null;
  const table = strategies(results.data);
  if (!table.length && !signal.data && !problem) return null;
  return { strategies: table, signals: signal.data ? sleeves(signal.data) : null, problem };
}

async function readHistory(): Promise<ReturnType<typeof trend>> {
  try {
    const res = await fetch(HISTORY_URL, { headers: { accept: "application/json" } });
    return res.ok ? trend(await res.json()) : [];
  } catch (error) {
    console.error("lab history fetch failed", String(error));
    return [];
  }
}

// Retaining a successful read must not freeze its freshness label at fetch time.
// Keep fetched_at and findings intact; only the displayed age advances.
function ageCached(cached: Cached, now: number): Cached {
  return cached.summary
    ? { ...cached, summary: { ...cached.summary, ...ageFields(cached.summary.generated_at, now) } }
    : cached;
}

async function readLab(env: Env, now: number): Promise<Cached> {
  let problem = "The lab file could not be reached just now.";
  for (const url of [LAB_URL, LAB_URL_FALLBACK]) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) {
        const [body, history, swing] = await Promise.all([res.json(), readHistory(), readSwing()]);
        return { fetched_at: now, summary: { ...summarize(body, now), source: url, trend: history, swing } };
      }
      problem = `The lab file answered ${res.status}.`;
    } catch (error) {
      console.error("lab fetch failed", url, String(error));
    }
  }
  return { fetched_at: now, problem };
}

/** The lab's findings, re-read at most once an hour unless you ask for fresh. */
export async function getResearch(env: Env, opts: { refresh?: boolean } = {}): Promise<Cached & { from_cache: boolean }> {
  const now = Date.now();
  const stored = await db.getSetting(env, CACHE_KEY);
  if (!opts.refresh && stored) {
    try {
      const cached = JSON.parse(stored) as Cached;
      if (now - cached.fetched_at < FRESH_FOR_MS) return { ...ageCached(cached, now), from_cache: true };
    } catch {
      // A damaged cache is not worth reporting; just read the lab again.
    }
  }
  const fresh = await readLab(env, now);
  // Never let a failed read throw away findings that are still useful.
  if (!fresh.summary && stored) {
    try {
      const cached = JSON.parse(stored) as Cached;
      if (cached.summary) return { ...ageCached(cached, now), problem: fresh.problem, from_cache: true };
    } catch {
      // fall through to the failure below
    }
  }
  await db.setSetting(env, CACHE_KEY, JSON.stringify(fresh));
  return { ...fresh, from_cache: false };
}

export async function forAgent(env: Env, actor: Actor, opts: { refresh?: boolean } = {}) {
  requireScope(actor, "hub:read");
  const result = await getResearch(env, opts);
  if (!result.summary) throw new HubError(503, "lab_unavailable", result.problem ?? "The lab's results could not be read.");
  return {
    ...result.summary,
    read_at: new Date(result.fetched_at).toISOString(),
    how_to_use:
      "swing holds a second, separate study: twenty years of daily bars testing slow strategies, with its two trend readings. Treat it as the better-evidenced of the two labs and say which one a number came from. The legacy held_up field contains producer-selected promising patterns, not confirmed unseen successes. Read unseen_result and unseen metrics separately from the earlier validation sample; missing results are unknown and selection evidence labels do not prove an edge. Cite these findings when you write or review a plan. A plan whose stop or setup sits in stay_away_from should be objected to with the number quoted. Never present a backtest as a prediction, and never treat a finding as permission to trade. In what_moves_the_odds, use only entries with knowable_at_entry true as a reason to take or skip a trade; the rest describe what happened after the entry and cannot be used to choose one.",
    ...(result.problem ? { note: `Showing the last good read. ${result.problem}` } : {}),
  };
}
