import { env as rawEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as db from "../src/db";
import * as news from "../src/news";
import type { Env } from "../src/util";

const base = rawEnv as unknown as Env;
const armed = (token = "shared-secret") => ({ ...base, DB: base.DB, RADAR_TOKEN: token }) as Env & { RADAR_TOKEN?: string };
const ITEM = {
  id: "n1",
  headline: "Company files an 8-K",
  source: "Alpaca News",
  url: "https://example.com/news/1",
  symbols: ["abc", "ABC", "bad symbol"],
  published_at: "2026-11-23T15:58:00Z",
  first_seen_at: "2026-11-23T15:59:00Z",
};
const post = (body: unknown, token?: string) => new Request("https://hub.example/api/news", {
  method: "POST",
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(async () => { await db.setSetting(base, "overview_news_latest", ""); vi.restoreAllMocks(); });

describe("cleaning watcher news", () => {
  it("keeps bounded, display-safe facts and normalizes symbols and zoned times", () => {
    const cleaned = news.clean({ feed_at: "2026-11-23T16:00:00Z", items: [ITEM] }, Date.parse("2026-11-23T16:00:30Z"));
    expect(cleaned.items).toHaveLength(1);
    expect(cleaned.items[0]).toMatchObject({ symbols: ["ABC"], published_at: "2026-11-23T15:58:00.000Z" });
    expect(JSON.stringify(cleaned)).not.toContain("bad symbol");
  });

  it("rejects unzoned times, non-HTTPS links, missing tags and future information", () => {
    const received = Date.parse("2026-11-23T16:00:00Z");
    const rows = [
      { ...ITEM, published_at: "2026-11-23T15:58:00" },
      { ...ITEM, url: "javascript:alert(1)" },
      { ...ITEM, symbols: [] },
      { ...ITEM, published_at: "2026-11-23T17:00:00Z" },
    ];
    expect(news.clean({ items: rows }, received).items).toEqual([]);
  });

  it("caps one update at 30 items", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...ITEM, id: String(i), headline: `Headline ${i}` }));
    expect(news.clean({ items: rows }, Date.parse("2026-11-23T16:00:00Z")).items).toHaveLength(30);
  });
});

describe("authenticated news receiver", () => {
  it("refuses missing setup and wrong credentials", async () => {
    await expect(news.receive(base, post({ items: [ITEM] }, "x"))).rejects.toMatchObject({ code: "news_not_set_up", status: 503 });
    await expect(news.receive(armed(), post({ items: [ITEM] }, "wrong"))).rejects.toMatchObject({ code: "bad_news_token", status: 401 });
  });

  it("stores an accepted update and reports freshness from receipt time", async () => {
    const now = Date.parse("2026-11-23T16:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await news.receive(armed(), post({ feed_at: "2026-11-23T16:00:00Z", items: [ITEM] }, "shared-secret"));
    expect(await news.current(base)).toMatchObject({ stale: false, age_minutes: 0, items: [{ headline: ITEM.headline }] });
    clock.mockReturnValue(now + 16 * 60_000);
    expect(await news.current(base)).toMatchObject({ stale: true, age_minutes: 16 });
  });

  it("does not accept unreadable JSON", async () => {
    await expect(news.receive(armed(), post("not json", "shared-secret"))).rejects.toMatchObject({ code: "news_not_json", status: 400 });
  });
});
