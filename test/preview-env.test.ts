// A Preview runs the live code at a public address against the test database.
// What must never reach it is anything that acts outside itself: the watcher
// token, the wake keys, or the live hub's own address. See hub job #14 and
// ChatGPT's isolatedEnv in PR #28, whose idea this is.
import { describe, expect, it } from "vitest";
import { previewEnv } from "../src/index";

const full = {
  DB: { live: false },
  OAUTH_KV: { live: false },
  ASSETS: { fetch: async () => new Response("") },
  AI: {},
  HUB_URL: "https://alpaca-breakout-watcher.driftline-provisions.workers.dev",
  RADAR_TOKEN: "synthetic-watcher-token",
  WAKE_CLAUDE_URL: "https://example.invalid/wake",
  WAKE_CLAUDE_TOKEN: "synthetic",
  WAKE_GROK_URL: "https://example.invalid/wake",
  WAKE_GROK_SECRET: "synthetic",
} as any;

describe("what a preview is allowed to hold", () => {
  it("keeps storage, assets and the AI binding", () => {
    const scoped = previewEnv({ ...full, HUB_ENV: "preview" });
    expect(Object.keys(scoped).sort()).toEqual(["AI", "ASSETS", "DB", "HUB_ENV", "OAUTH_KV"]);
    expect(scoped.DB).toBe(full.DB);
    expect(scoped.OAUTH_KV).toBe(full.OAUTH_KV);
  });

  it("drops the watcher token, so a preview cannot accept a real scan", () => {
    const scoped = previewEnv({ ...full, HUB_ENV: "preview" }) as any;
    expect(scoped.RADAR_TOKEN).toBeUndefined();
  });

  it("drops every wake key, so a public test page cannot ring Casey's AIs", () => {
    const scoped = previewEnv({ ...full, HUB_ENV: "preview" }) as any;
    for (const key of Object.keys(full)) {
      if (key.startsWith("WAKE_")) expect(scoped[key], key).toBeUndefined();
    }
  });

  it("drops the live hub's address, so a preview never sends anyone there to sign in", () => {
    const scoped = previewEnv({ ...full, HUB_ENV: "preview" }) as any;
    expect(scoped.HUB_URL).toBeUndefined();
  });

  it("leaves production exactly as it is, whatever the variable says", () => {
    for (const env of [full, { ...full, HUB_ENV: "production" }, { ...full, HUB_ENV: "" }]) {
      expect(previewEnv(env)).toBe(env);
    }
  });

  it("does not invent bindings a preview was not given", () => {
    const sparse = { DB: {}, OAUTH_KV: {}, HUB_ENV: "preview" } as any;
    expect(Object.keys(previewEnv(sparse)).sort()).toEqual(["DB", "HUB_ENV", "OAUTH_KV"]);
  });
});
