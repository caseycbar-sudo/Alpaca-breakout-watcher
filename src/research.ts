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

export const LAB_URL = "https://caseycbar-sudo.github.io/Alpaca-breakout-watcher/data/backtest.json";
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

/** Keep the patterns worth naming: what held up, and what to stay away from. */
function patternList(raw: unknown, limit: number) {
  return arr(raw)
    .slice(0, limit)
    .map((p) => {
      const o = obj(p);
      const test = obj(o.test);
      return {
        pattern: str(o.pattern) || str(o.bucket) || "unnamed",
        verdict: str(o.verdict) || null,
        evidence: str(o.evidence) || null,
        trades_checked: num(test.n),
        avg_r: round(num(test.avg_r)),
        win_rate: round(num(test.win_rate), 1),
      };
    })
    .filter((p) => p.pattern !== "unnamed");
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
  caveat: string;
}

export function summarize(raw: unknown, now = Date.now()): Summary {
  const d = obj(raw);
  const summary = obj(d.summary);
  const patterns = obj(d.patterns);
  const w = obj(d.window);
  const generated = str(d.generated_at) || null;
  const ms = generated ? Date.parse(generated) : NaN;
  const ageDays = Number.isFinite(ms) ? Math.floor((now - ms) / 86_400_000) : null;
  const loose = run(summary.learning);
  const strict = run(summary.strict_setups);
  const trading = num(w.trading_days);
  return {
    source: LAB_URL,
    generated_at: generated,
    age_days: ageDays,
    stale: ageDays === null || ageDays > STALE_AFTER_DAYS,
    window: { start: str(w.start) || null, end: str(w.end) || null, trading_days: trading },
    headline: headline(loose, strict, summary.validated === true, trading),
    every_signal: loose,
    strict_rules: strict,
    model: { status: str(obj(d.model).status) || null, verdict: str(obj(d.model).verdict) || null },
    stay_away_from: patternList(patterns.avoid, 8),
    held_up: patternList(patterns.promising, 8),
    caveat:
      "These are backtested results from Casey's own lab, with modeled spread and slippage. They describe what the rules would have done, not what any trade will do. The hub cannot place orders, and nothing here is advice.",
  };
}

interface Cached {
  fetched_at: number;
  summary?: Summary;
  problem?: string;
}

async function readLab(env: Env, now: number): Promise<Cached> {
  try {
    const res = await fetch(LAB_URL, { headers: { accept: "application/json" } });
    if (!res.ok) return { fetched_at: now, problem: `The lab page answered ${res.status}.` };
    return { fetched_at: now, summary: summarize(await res.json(), now) };
  } catch (error) {
    console.error("lab fetch failed", String(error));
    return { fetched_at: now, problem: "The lab page could not be reached just now." };
  }
}

/** The lab's findings, re-read at most once an hour unless you ask for fresh. */
export async function getResearch(env: Env, opts: { refresh?: boolean } = {}): Promise<Cached & { from_cache: boolean }> {
  const now = Date.now();
  const stored = await db.getSetting(env, CACHE_KEY);
  if (!opts.refresh && stored) {
    try {
      const cached = JSON.parse(stored) as Cached;
      if (now - cached.fetched_at < FRESH_FOR_MS) return { ...cached, from_cache: true };
    } catch {
      // A damaged cache is not worth reporting; just read the lab again.
    }
  }
  const fresh = await readLab(env, now);
  // Never let a failed read throw away findings that are still useful.
  if (!fresh.summary && stored) {
    try {
      const cached = JSON.parse(stored) as Cached;
      if (cached.summary) return { ...cached, problem: fresh.problem, from_cache: true };
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
      "Cite these findings when you write or review a plan. A plan whose stop or setup sits in stay_away_from should be objected to with the number quoted. Never present a backtest as a prediction, and never treat a finding as permission to trade.",
    ...(result.problem ? { note: `Showing the last good read. ${result.problem}` } : {}),
  };
}
