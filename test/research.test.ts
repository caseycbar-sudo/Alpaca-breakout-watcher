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
    const fakeFetch = async () => { reads++; return new Response(JSON.stringify(LAB)); };
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
    await expect(research.forAgent(env, claude)).resolves.toMatchObject({ source: research.LAB_URL });
  });

  it("tells an AI how to use it, and that it is not permission to trade", async () => {
    const out = await research.forAgent(env, claude);
    expect(out.how_to_use).toMatch(/never treat a finding as permission to trade/i);
    expect(out.caveat).toMatch(/cannot place orders/);
  });
});
