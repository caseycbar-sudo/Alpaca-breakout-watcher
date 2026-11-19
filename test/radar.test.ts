// The live radar: what the watcher last saw, and who is allowed to send it.
import { env as rawEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import * as radar from "../src/radar";
import type { Actor, Env } from "../src/util";

const base = rawEnv as unknown as Env & { RADAR_TOKEN?: string };
const claude: Actor = { kind: "agent", id: "claude", name: "Claude", scopes: ["hub:read"] };
const armed = (token = "shared-secret") => ({ ...base, DB: base.DB, RADAR_TOKEN: token }) as Env & { RADAR_TOKEN?: string };

const SCAN = {
  generated_at: new Date().toISOString(),
  market: { phase: "regular session", is_open: true, next_close: "2026-11-17T16:00:00-05:00" },
  system: { market_data: "Alpaca IEX", nasdaq_halts: "online · 23 active", sec_edgar: "unavailable", note: "No confirmed setup." },
  candidates: [
    {
      symbol: "ONFO", price: 1.23, spread_pct: 0.2, day_move_pct: 4.1, relative_volume: 2.2, rsi: 61,
      breakout_level: 1.2, technical_stop: 1.15, stage: "confirmed", setup: "A — catalyst ORB", market_context: "aligned",
      news_headline: "Contract award announced", news_time: "2026-11-17T13:05:00-05:00", news_url: "https://example.com/pr",
      news_first_seen: "2026-11-17T13:06:00-05:00",
      risk_sources: ["Offering filed 2 days ago"], stocktwits_message_count_1h: 40, stocktwits_bullish_pct: 80,
      account_number: "977962828", api_key: "should never travel",
    },
  ],
  gates: [{ label: "Price", rule: "$0.50–$100.00" }],
  research_log: [{ time: "13:05", headline: "Halt list refreshed" }],
};

const post = (body: unknown, token?: string) =>
  new Request("https://hub.example/api/radar", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("receiving a scan", () => {
  it("refuses everything until Casey sets a token", async () => {
    await expect(radar.receive(base, post(SCAN, "anything"))).rejects.toMatchObject({ code: "radar_not_set_up" });
  });

  it("refuses a wrong or missing token", async () => {
    await expect(radar.receive(armed(), post(SCAN))).rejects.toMatchObject({ code: "bad_radar_token", status: 401 });
    await expect(radar.receive(armed(), post(SCAN, "guess"))).rejects.toMatchObject({ code: "bad_radar_token" });
  });

  it("keeps only market research, and drops anything account-shaped", async () => {
    const scan = await radar.receive(armed(), post(SCAN, "shared-secret"));
    expect(scan.candidate_count).toBe(1);
    const found = JSON.stringify(scan);
    expect(found).not.toContain("977962828");
    expect(found).not.toContain("should never travel");
    expect(scan.candidates[0]).toMatchObject({ symbol: "ONFO", breakout_level: 1.2, technical_stop: 1.15 });
    expect(scan.candidates[0].news).toMatchObject({ headline: "Contract award announced", published_at: "2026-11-17T13:05:00-05:00" });
    expect(scan.candidates[0].checks.risk_sources).toEqual(["Offering filed 2 days ago"]);
    expect(scan.candidates[0].attention.note).toMatch(/never a catalyst/);
  });

  it("refuses a body that is not JSON, or is too big", async () => {
    await expect(radar.receive(armed(), post("not json", "shared-secret"))).rejects.toMatchObject({ code: "radar_not_json" });
    const huge = JSON.stringify({ filler: "x".repeat(radar.MAX_BODY_BYTES) });
    await expect(radar.receive(armed(), post(huge, "shared-secret"))).rejects.toMatchObject({ code: "radar_too_big", status: 413 });
  });
});

describe("reading the radar", () => {
  it("ignores a copy with no timestamp rather than calling it the newest", async () => {
    // The public repo has long carried an empty placeholder dashboard with no time on it.
    const empty = radar.clean({ schema_version: 1, generated_at: null, candidates: [] }, "published with the nightly lab run");
    expect(empty.generated_at).toBeNull();
    await radar.receive(armed(), post(SCAN, "shared-secret"));
    const shown = await radar.current(base);
    expect(shown?.generated_at).toBe(SCAN.generated_at); // the real scan wins
  });

  it("shows an empty scan as the normal answer, not an error", () => {
    const quiet = radar.clean({ generated_at: "2026-11-17T18:16:42Z", market: { phase: "regular session", is_open: true }, candidates: [], system: { note: "No confirmed setup or account-risk change." } }, "posted by the watcher");
    expect(quiet.candidate_count).toBe(0);
    expect(quiet.candidates).toEqual([]);
    expect(quiet.note).toBe("No confirmed setup or account-risk change.");
  });

  it("does not present a scan-time headline lookup as verified catalyst news", () => {
    const scan = radar.clean({
      generated_at: "2026-11-17T18:16:42Z",
      candidates: [],
      gates: [{
        label: "Catalyst: verified news within 24 hours",
        rule: "Requires verified news and rejects stale headlines",
      }],
    }, "posted by the watcher");
    expect(scan.gates).toEqual([{
      label: "Recent headline: published within 24 hours",
      rule: "Requires a headline published in the scan lookback and rejects stale headlines",
    }]);
    expect(JSON.stringify(scan.gates).toLowerCase()).not.toContain("verified news");
  });

  it("says how old the scan is and when it has stopped being 'now'", async () => {
    // The published copy is a real URL, so hold it still: this is about the posted one.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    // Clear anything an earlier read cached, so this is only about the posted scan.
    await db.setSetting(base, "radar_published", JSON.stringify({ stored_at: Date.now(), radar: { generated_at: null } }));
    try {
    const old = { ...SCAN, generated_at: new Date(Date.now() - 3 * 3600_000).toISOString() };
    await radar.receive(armed(), post(old, "shared-secret"));
    const shown = await radar.current(base);
    expect(shown?.age_minutes).toBeGreaterThan(150);
    expect(shown?.stale).toBe(true);

    await radar.receive(armed(), post(SCAN, "shared-secret"));
    const now = await radar.current(base);
    expect(now?.stale).toBe(false);
    expect(now?.live_feed_connected).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("tells an AI that an empty list is not a reason to loosen anything", async () => {
    const out = await radar.forAgent(base, claude);
    expect(out.how_to_use).toMatch(/do not treat it as a reason to loosen anything/);
    expect(out.how_to_use).toMatch(/never present this as permission to trade/);
  });

  it("needs read permission", async () => {
    await expect(radar.forAgent(base, { kind: "agent", id: "x", name: "X", scopes: [] })).rejects.toMatchObject({ code: "not_permitted" });
  });

  it("says whether a headline could have been known when the scan ran", () => {
    const at = (iso: string, extra: Record<string, unknown> = {}) =>
      radar.clean({ generated_at: "2026-11-17T18:30:00Z", candidates: [{ symbol: "X", news_headline: "h", news_time: iso, ...extra }] }, "posted by the watcher").candidates[0].news;

    // Published and seen before the scan: usable as evidence.
    expect(at("2026-11-17T18:00:00Z", { news_first_seen: "2026-11-17T18:05:00Z" })).toMatchObject({ verdict: "ok", available_at: "2026-11-17T18:05:00.000Z" });
    // Stamped after the scan that carries it: it cannot have informed that scan.
    expect(at("2026-11-17T18:45:00Z").verdict).toBe("FAIL_FUTURE_INFORMATION");
    // Seen after the scan finished even though published before it: still unusable.
    expect(radar.clean({ generated_at: "2026-11-17T18:30:00Z", published_at: "2026-11-17T18:30:05Z",
      candidates: [{ symbol: "X", news_headline: "h", news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:45:00Z" }] },
      "posted by the watcher").candidates[0].news.verdict).toBe("FAIL_FUTURE_INFORMATION");
    // Without a completion time the same sighting is unresolvable rather than condemned,
    // because a slow scan and a backfill look the same. Either way it is not "ok", so it
    // still cannot be used as a catalyst.
    expect(at("2026-11-17T18:00:00Z", { news_first_seen: "2026-11-17T18:45:00Z" }).verdict).toBe("UNKNOWN_SCAN_WINDOW");
    // Publication time only, which is what the watcher reports today: availability is a guess.
    expect(at("2026-11-17T18:00:00Z").verdict).toBe("UNKNOWN_INGESTION");
    // Nothing readable at all is never quietly treated as fine.
    expect(at("not a date").verdict).toBe("UNKNOWN_TIME");
  });

  // ChatGPT found all three of these passing as "ok" in the first version. Each one
  // let an unanswerable question through as proof that a candidate had a catalyst.
  it("fails closed when a time is missing, unzoned or uncheckable", () => {
    const news = (candidate: Record<string, unknown>, scan: unknown = "2026-11-17T18:30:00Z") =>
      radar.clean({ generated_at: scan, candidates: [{ symbol: "X", news_headline: "h", ...candidate }] }, "posted by the watcher").candidates[0].news;

    // A sighting with no publication time says when we saw it, not when it was news.
    expect(news({ news_first_seen: "2026-11-17T18:05:00Z" })).toMatchObject({ verdict: "UNKNOWN_TIME", available_at: null });
    // With no readable scan time there is nothing to compare against.
    expect(news({ news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:05:00Z" }, null).verdict).toBe("UNKNOWN_TIME");
    // A bare local time is not proof of anything, however much it looks like a timestamp.
    expect(news({ news_time: "2026-11-17T18:00:00", news_first_seen: "2026-11-17T18:05:00" }).verdict).toBe("UNKNOWN_TIME");
    // And the offset forms that ARE valid still work.
    expect(news({ news_time: "2026-11-17T13:00:00-05:00", news_first_seen: "2026-11-17T13:05:00-05:00" }).verdict).toBe("ok");
    // A mangled sighting time is no better than a missing one: not "ok" either way.
    expect(news({ news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T1805:00Z" }).verdict).toBe("UNKNOWN_INGESTION");
  });

  // Job #9. The watcher now sends news_first_seen, so these reach "ok" where they used to
  // read UNKNOWN_INGESTION. "ok" earned by the scan fetching the headline itself is much
  // weaker than "ok" earned by a live sighting, and the basis has to say which it is,
  // otherwise the field just turns every headline green.
  it("says how the watcher got a headline, and does not overclaim a scan-time fetch", () => {
    const news = (candidate: Record<string, unknown>) =>
      radar.clean({ generated_at: "2026-11-17T18:30:00Z", candidates: [{ symbol: "X", news_headline: "h", ...candidate }] }, "posted by the watcher").candidates[0].news;

    // A fetch made by the scan itself. Equal timestamps are fine: it still cannot be from
    // the future. But the basis must not claim the headline was there in time to act on.
    const fetched = news({ news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:30:00Z", news_seen_via: "scan_fetch" });
    expect(fetched.verdict).toBe("ok");
    expect(fetched.seen_via).toBe("scan_fetch");
    expect(fetched.basis).toContain("does not show the headline was available early enough to act on");

    // A live sighting is the stronger case, and says so.
    const streamed = news({ news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:05:00Z", news_seen_via: "live_stream" });
    expect(streamed.verdict).toBe("ok");
    expect(streamed.basis).toContain("seen live");
    // Seen before the scan started, so the strong claim is earned.
    expect(streamed.basis).toContain("before the scan started");

    // ChatGPT's second catch. A live sighting DURING the scan is still ok, but it must
    // not claim the watcher held the headline going in: the bound only proves it arrived
    // before the scan finished. A setup forming at the decision time was not informed by
    // news that landed two seconds later.
    const midScan = radar.clean({ generated_at: "2026-11-17T18:30:00Z", published_at: "2026-11-17T18:30:05Z",
      candidates: [{ symbol: "X", news_headline: "h", news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:30:02Z", news_seen_via: "live_stream" }] },
      "posted by the watcher").candidates[0].news;
    expect(midScan.verdict).toBe("ok");
    expect(midScan.basis).toContain("not before it began");
    expect(midScan.basis).not.toContain("before the scan started");

    // How it arrived is still optional, and an unlabelled sighting admits that.
    expect(news({ news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:05:00Z" }).basis).toContain("not recorded");

    // A sighting stamped after the scan finished stays a failure whatever label comes with it.
    expect(radar.clean({ generated_at: "2026-11-17T18:30:00Z", published_at: "2026-11-17T18:30:05Z",
      candidates: [{ symbol: "X", news_headline: "h", news_time: "2026-11-17T18:00:00Z", news_first_seen: "2026-11-17T18:45:00Z", news_seen_via: "scan_fetch" }] },
      "posted by the watcher").candidates[0].news.verdict).toBe("FAIL_FUTURE_INFORMATION");
    // And a label alone never buys a verdict.
    expect(news({ news_seen_via: "live_stream" }).verdict).toBe("UNKNOWN_TIME");
  });

  // ChatGPT's rework of job #9. My first version compared a sighting against the scan's
  // DECISION time, which the watcher fixes before it reads anything. A scan then spends
  // real seconds fetching, so every genuine headline is stamped after it. The result was
  // not a weak "ok" but a confident FAIL on every real candidate: the hub would have
  // reported that a headline could not have informed the scan that fetched it.
  // The comparison belongs at the END of the scan's window.
  it("treats a headline fetched partway through a scan as available to it", () => {
    const news = (c: Record<string, unknown>, scan: unknown, publishedAt?: unknown) =>
      radar.clean({ generated_at: scan, published_at: publishedAt, candidates: [{ symbol: "X", news_headline: "h", ...c }] }, "posted by the watcher").candidates[0].news;

    // The real order: decision clock 17:30:00, REST fetch returns 17:30:02, scan written
    // 17:30:05. This is the exact shape ChatGPT reproduced as a failure.
    const real = { news_time: "2026-11-17T17:00:00Z", news_first_seen: "2026-11-17T17:30:02Z", news_seen_via: "scan_fetch" };
    expect(news(real, "2026-11-17T17:30:00Z", "2026-11-17T17:30:05Z").verdict).toBe("ok");

    // A backfill after the scan finished is still caught. This is the case the guard exists for.
    expect(news({ ...real, news_first_seen: "2026-11-17T17:31:00Z" }, "2026-11-17T17:30:00Z", "2026-11-17T17:30:05Z").verdict).toBe("FAIL_FUTURE_INFORMATION");

    // No completion time: a mid-scan fetch and a later backfill look identical, so the
    // honest answer is neither "ok" nor an accusation.
    expect(news(real, "2026-11-17T17:30:00Z").verdict).toBe("UNKNOWN_SCAN_WINDOW");

    // A completion time earlier than the decision time is a broken pair. Don't trust it
    // to widen the window; fall back to the unresolvable case.
    expect(news(real, "2026-11-17T17:30:00Z", "2026-11-17T17:29:00Z").verdict).toBe("UNKNOWN_SCAN_WINDOW");
    // An unzoned completion time is not a completion time.
    expect(news(real, "2026-11-17T17:30:00Z", "2026-11-17T17:30:05").verdict).toBe("UNKNOWN_SCAN_WINDOW");

    // A sighting before the decision clock never needed the window at all.
    expect(news({ ...real, news_first_seen: "2026-11-17T17:29:00Z" }, "2026-11-17T17:30:00Z").verdict).toBe("ok");
  });
});

describe("the ticker strip", () => {
  const quotes = (rows: unknown[]) =>
    radar.clean({ generated_at: "2026-11-18T18:30:00Z", quotes: rows, candidates: [] }, "posted by the watcher").quotes;

  it("ages a price at read time so it cannot freeze", () => {
    const fresh = new Date(Date.now() - 90_000).toISOString();
    const [q] = quotes([{ symbol: "QQQ", price: 756.02, change_pct: 1.2, at: fresh, available: true }]);
    expect(q.available).toBe(true);
    expect(q.age_seconds).toBeGreaterThanOrEqual(89);
    expect(q.age_seconds).toBeLessThan(120);
  });

  // The strip moves, so it reads as live. Everything here exists to stop it lying.
  it("refuses to show a price it cannot stand behind", () => {
    // Marked unavailable by the watcher: no price, and it says why.
    const [gone] = quotes([{ symbol: "PSQ", price: null, at: null, available: false }]);
    expect(gone.price).toBeNull();
    expect(gone.note).toContain("No price is shown rather than an old one");

    // available:true with no price is a contradiction. Trusting the flag would put an
    // empty slot on the strip looking like a real quote.
    const [liar] = quotes([{ symbol: "SPY", price: null, at: "2026-11-18T18:29:00Z", available: true }]);
    expect(liar.available).toBe(false);

    // An undated price is real but we cannot say when it was true.
    const [undated] = quotes([{ symbol: "QQQ", price: 756.02, at: null, available: true }]);
    expect(undated.price).toBe(756.02);
    expect(undated.age_seconds).toBeNull();

    // An unzoned stamp is not a stamp.
    const [unzoned] = quotes([{ symbol: "QQQ", price: 1, at: "2026-11-18T18:29:00", available: true }]);
    expect(unzoned.age_seconds).toBeNull();
  });

  it("keeps the strip short and drops nameless rows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ symbol: `S${i}`, price: 1, available: true }));
    expect(quotes([...many, { price: 9, available: true }]).length).toBe(12);
  });
});

// ChatGPT's finding on the revamp. clean()'s output is STORED, so any age computed
// inside it freezes at ingestion. The browser recomputes from `at` and was never
// affected, but get_radar is what ChatGPT and Grok read, and a cached scan would have
// kept handing them a fresh-looking quote age indefinitely. Same bug class as the
// cached lab staleness fixed earlier today, which is why this test advances a clock
// rather than just asserting a number once.
describe("quote ages on a cached scan", () => {
  it("re-ages every quote from its own timestamp on each read", async () => {
    const realNow = Date.now;
    const at = "2026-11-18T19:58:00+00:00";
    const stored = radar.clean(
      { generated_at: "2026-11-18T19:59:00+00:00", published_at: "2026-11-18T19:59:02+00:00", candidates: [],
        quotes: [{ symbol: "TEST", price: 10, change_pct: 0.5, at, available: true },
                 { symbol: "NOTIME", price: 11, at: null, available: true }] },
      "posted by the watcher");
    // Clear the posted copy first: an earlier test in this file posts a scan stamped
    // "now", which would outrank this fixture and silently test nothing.
    const priorPosted = await db.getSetting(base, "radar_latest");
    await db.setSetting(base, "radar_latest", "");
    await db.setSetting(base, "radar_published", JSON.stringify({ stored_at: Date.parse("2026-11-18T20:00:00Z"), radar: stored }));

    const ageAt = async (iso: string) => {
      Date.now = () => Date.parse(iso);
      try {
        const v = await radar.current(base);
        return { quote: v!.quotes.find((q) => q.symbol === "TEST")!.age_seconds,
                 undated: v!.quotes.find((q) => q.symbol === "NOTIME")!.age_seconds,
                 radar: v!.age_minutes };
      } finally { Date.now = realNow; }
    };

    const first = await ageAt("2026-11-18T20:00:00Z");
    expect(first.quote).toBe(120);

    // One minute later, same stored scan. The quote must age with the clock, exactly as
    // the radar's own age_minutes already did.
    const later = await ageAt("2026-11-18T20:01:00Z");
    expect(later.quote).toBe(180);
    expect(later.radar).toBe(2);

    // A quote with no usable time stays unknown instead of being handed a number.
    expect(first.undated).toBeNull();
    expect(later.undated).toBeNull();

    await db.setSetting(base, "radar_published", "");
    await db.setSetting(base, "radar_latest", priorPosted ?? "");
  });
});
