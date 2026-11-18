// Reading Casey's breakout lab into the hub.
import { env as rawEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as research from "../src/research";
import type { Actor, Env } from "../src/util";

const env = rawEnv as unknown as Env;
const claude: Actor = { kind: "agent", id: "claude", name: "Claude", scopes: ["hub:read"] };
const nosy: Actor = { kind: "agent", id: "grok", name: "Grok", scopes: [] };

// Shaped like the real file, with the numbers the lab actually reported.
const LAB = {
  schema_version: 1,
  generated_at: "2026-11-14T01:28:22.748229+00:00",
  window: { start: "2026-07-17", end: "2026-11-14", trading_days: 85 },
  summary: {
    learning: { trades: 1187, win_rate: 30.83, avg_r: -0.3495, profit_factor: 0.5 },
    strict_setups: { trades: 3, win_rate: 33.33, avg_r: 0.0, profit_factor: 1.0 },
    validated: false,
  },
  model: { status: "faint", verdict: "A faint signal on unseen days." },
  patterns: {
    avoid: [{ pattern: "Stop distance: under 0.5%", verdict: "avoid", evidence: "strong", test: { n: 160, avg_r: -1.3, win_rate: 12.5 } }],
    promising: [],
  },
};

describe("reading the lab", () => {
  it("preserves unseen outcomes separately from earlier validation metrics", () => {
    const s = research.summarize({ patterns: {
      promising: [{ pattern: "Selected pattern", evidence: "strong", test: { n: 27, avg_r: 0.2166 }, unseen: { n: 51, avg_r: -0.2751, win_rate: 33.3 }, unseen_result: "did not hold up" }],
      avoid: [{ pattern: "Weak candidate", test: { n: 31, avg_r: -0.9275 }, unseen: { n: 4, avg_r: 0.8459 }, unseen_result: "too few trades" }],
    } });
    expect(s.held_up[0]).toMatchObject({ trades_checked: 27, avg_r: 0.22, unseen_result: "did not hold up", unseen: { trades: 51, avg_r: -0.28, win_rate: 33.3 } });
    expect(s.stay_away_from[0]).toMatchObject({ unseen_result: "too few trades", unseen: { trades: 4, avg_r: 0.85 } });
  });

  it("keeps unreported unseen validation unknown", () => {
    const s = research.summarize({ patterns: { promising: [{ pattern: "Legacy pattern", test: { n: 20, avg_r: 0.2 } }] } });
    expect(s.held_up[0]).toMatchObject({ unseen_result: null, unseen: { trades: null, avg_r: null, win_rate: null } });
  });

  it("turns the numbers into one sentence Casey can act on", () => {
    const s = research.summarize(LAB, Date.parse("2026-11-17T00:00:00Z"));
    expect(s.headline).toContain("lost money across 1187 trades");
    expect(s.headline).toContain("3 trades in 85 trading days");
    expect(s.headline).toContain("No edge is proven yet");
    expect(s.age_days).toBe(2);
    expect(s.stale).toBe(false);
    expect(s.every_signal).toEqual({ trades: 1187, win_rate: 30.8, avg_r: -0.35, profit_factor: 0.5 });
    expect(s.stay_away_from[0]).toMatchObject({ pattern: "Stop distance: under 0.5%", avg_r: -1.3, trades_checked: 160 });
  });

  it("pulls out the conditions that changed the odds, biggest gap first", () => {
    const s = research.summarize({
      ...LAB,
      analytics: {
        follow_through: [
          { key: "a", label: "Small thing", yes: { trades: 10, win_rate: 30, avg_r: -0.4 }, no: { trades: 10, win_rate: 28, avg_r: -0.5 } },
          { key: "b", label: "Second candle green", yes: { trades: 429, win_rate: 40.79, avg_r: -0.087 }, no: { trades: 629, win_rate: 19.4, avg_r: -0.68 } },
        ],
        outcomes: [{ reason: "target", label: "Target hit", trades: 112, avg_r: 2.1 }, { reason: "stop", label: "Stopped out", trades: 623, avg_r: -1 }],
        days: { trading_days: 85, green_days: 17, red_days: 68, average_day_r: -5.483, best_day: { date: "2026-08-03", trades: 14, total_r: 14.35 } },
      },
      tickers: [
        { symbol: "CYAB", learning: { trades: 15, win_rate: 46.67, avg_r: 0.4989 }, note: "Breakouts have tended to follow through" },
        { symbol: "THIN", learning: { trades: 3, win_rate: 100, avg_r: 2 } },
      ],
    }, Date.now());
    expect(s.what_moves_the_odds[0].label).toBe("Second candle green");
    expect(s.what_moves_the_odds[0].knowable_at_entry).toBe(true); // key "b" is not a known after-entry field
    expect(s.what_moves_the_odds[0].difference_r).toBe(0.59);
    expect(s.how_trades_ended[1]).toMatchObject({ label: "Stopped out", trades: 623, share_pct: 84.8 });
    expect(s.day_shape.best_day).toEqual({ date: "2026-08-03", trades: 14, total_r: 14.35 });
    expect(s.symbols.map((t) => t.symbol)).toEqual(["CYAB"]); // THIN had too few trades to count
  });

  it("marks the conditions that are only known after entry, and warns about them", () => {
    const s = research.summarize({
      analytics: {
        follow_through: [
          { key: "held_breakout", label: "Entry bar held breakout level", yes: { trades: 907, win_rate: 30.65, avg_r: -0.303 }, no: { trades: 151, win_rate: 12.58, avg_r: -1.2665 } },
          { key: "spy_aligned", label: "SPY and QQQ aligned", yes: { trades: 400, win_rate: 33, avg_r: -0.2 }, no: { trades: 400, win_rate: 25, avg_r: -0.5 } },
        ],
      },
    }, Date.now());
    const byLabel = Object.fromEntries(s.what_moves_the_odds.map((x) => [x.label, x.knowable_at_entry]));
    expect(byLabel["Entry bar held breakout level"]).toBe(false);
    expect(byLabel["SPY and QQQ aligned"]).toBe(true);
    expect(s.lookahead_warning).toMatch(/not known when the decision is made/);
    expect(research.summarize({ analytics: { follow_through: [{ key: "spy_aligned", label: "x", yes: { trades: 1, avg_r: 1 }, no: { trades: 1, avg_r: 0 } }] } }, Date.now()).lookahead_warning).toBeNull();
  });

  it("says plainly when the lab has not run in weeks", () => {
    expect(research.summarize(LAB, Date.parse("2026-12-20T00:00:00Z")).stale).toBe(true);
    expect(research.summarize({}, Date.now()).stale).toBe(true); // nothing readable is stale too, never silently fresh
  });

  it("never invents a number the lab did not report", () => {
    const s = research.summarize({ summary: { learning: { trades: 5 } } }, Date.now());
    expect(s.every_signal).toEqual({ trades: 5, win_rate: null, avg_r: null, profit_factor: null });
    expect(s.generated_at).toBeNull();
    expect(s.model).toEqual({ status: null, verdict: null });
    expect(s.headline).toContain("No edge is proven yet");
  });

  it("caches the read, and refreshes only when asked", async () => {
    let reads = 0;
    const extras = [research.HISTORY_URL, research.SWING_RESULTS_URL, research.SWING_SIGNAL_URL];
    const fakeFetch = async (url: string) => { if (extras.includes(url)) return new Response("[]"); reads++; return new Response(JSON.stringify(LAB)); };
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const first = await research.getResearch(env, { refresh: true });
      expect(first.summary?.every_signal.trades).toBe(1187);
      expect(reads).toBe(1);
      expect((await research.getResearch(env)).from_cache).toBe(true);
      expect(reads).toBe(1);
      await research.getResearch(env, { refresh: true });
      expect(reads).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("falls back to the published page when the raw file is missing", async () => {
    const tried: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      tried.push(url);
      if ([research.HISTORY_URL, research.SWING_RESULTS_URL, research.SWING_SIGNAL_URL].includes(url)) return new Response("[]");
      return url === research.LAB_URL ? new Response("nope", { status: 404 }) : new Response(JSON.stringify(LAB));
    }) as unknown as typeof fetch;
    try {
      const result = await research.getResearch(env, { refresh: true });
      const extra = [research.HISTORY_URL, research.SWING_RESULTS_URL, research.SWING_SIGNAL_URL];
      expect(tried.filter((u) => !extra.includes(u))).toEqual([research.LAB_URL, research.LAB_URL_FALLBACK]);
      expect(result.summary?.source).toBe(research.LAB_URL_FALLBACK);
      expect(result.summary?.every_signal.trades).toBe(1187);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the last good findings when the lab page is down", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    try {
      const result = await research.getResearch(env, { refresh: true });
      expect(result.summary?.every_signal.trades).toBe(1187); // the earlier read, not nothing
      expect(result.problem).toMatch(/could not be reached/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("needs read permission, like everything else here", async () => {
    await expect(research.forAgent(env, nosy)).rejects.toMatchObject({ code: "not_permitted" });
    expect([research.LAB_URL, research.LAB_URL_FALLBACK]).toContain((await research.forAgent(env, claude)).source);
  });

  it("tells an AI how to use it, and that it is not permission to trade", async () => {
    const out = await research.forAgent(env, claude);
    expect(out.how_to_use).toMatch(/never treat a finding as permission to trade/i);
    expect(out.caveat).toMatch(/cannot place orders/);
  });
});

// The second lab: slow strategies on twenty years of daily bars.
describe("the swing lab", () => {
  it("ranks strategies by Sharpe and keeps the losers visible", () => {
    const table = research.strategies([
      { name: "SPY buy & hold", start: "2006-10-03", cagr: 11.2, maxdd: -55.2, sharpe: 0.64, trades_per_yr: 0, last3y: 23.2 },
      { name: "QQQ 200d trend filter", cagr: 11.2, maxdd: -26.2, sharpe: 0.76, trades_per_yr: 3 },
      { name: "Old style: crypto day trade", cagr: -82, maxdd: -100, sharpe: -4.7, trades_per_yr: 255 },
      { name: "no numbers here" },
    ]);
    expect(table.map((s) => s.name)).toEqual(["QQQ 200d trend filter", "SPY buy & hold", "Old style: crypto day trade"]);
    expect(table[0]).toMatchObject({ cagr: 11.2, worst_drawdown: -26.2, trades_per_year: 3 });
  });

  it("reads the trend signals and only accepts HOLD or CASH", () => {
    const out = research.sleeves({
      generated_at: "2026-11-17T18:59:25Z",
      sleeves: [
        { sleeve: "A", symbol: "QQQ", as_of: "2026-11-17", close: 654.135, length: 200, average: 681.5612, distance_pct: -4.01, signal: "CASH" },
        { sleeve: "B", symbol: "BTC-USD", close: 63709.71, length: 50, average: 78967.9, distance_pct: -19.32, signal: "HOLD" },
        { symbol: "NOPE", length: 10, signal: "maybe" },
      ],
    });
    expect(out.sleeves).toHaveLength(2);
    expect(out.sleeves[0]).toMatchObject({ symbol: "QQQ", signal: "CASH", distance_pct: -4.01, rule: "hold while above its 200-day average" });
    expect(out.sleeves[1].signal).toBe("HOLD");
  });
});
