import { env as rawEnv } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as calendar from "../src/calendar";
import * as db from "../src/db";
import type { Env } from "../src/util";

const base = rawEnv as unknown as Env;
const armed = (token = "shared-secret") => ({ ...base, DB: base.DB, RADAR_TOKEN: token }) as Env & { RADAR_TOKEN?: string };
const EVENT = {
  id: "bls-cpi",
  title: "Consumer Price Index",
  kind: "economic release",
  source: "U.S. Bureau of Labor Statistics",
  url: "https://www.bls.gov/schedule/",
  event_at: "2026-11-25T08:30:00-05:00",
  first_seen_at: "2026-11-23T12:00:00-05:00",
  period: "October 2026",
};
const post = (body: unknown, token?: string) => new Request("https://hub.example/api/calendar", {
  method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
  body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(async () => { await db.setSetting(base, "overview_macro_calendar_latest", ""); vi.restoreAllMocks(); });

describe("calendar cleaning", () => {
  it("keeps five trading days, named sources and zoned schedule facts", () => {
    const now = Date.parse("2026-11-23T18:00:00Z");
    const cleaned = calendar.clean({
      checked_at: "2026-11-23T17:59:00Z",
      trading_days: ["2026-11-23","2026-11-24","2026-11-25","2026-11-27","2026-11-30","2026-12-01"],
      events: [EVENT],
      sources: [{ name: "BLS", status: "ok", checked_at: "2026-11-23T17:59:00Z" }],
    }, now);
    expect(cleaned.trading_days).toHaveLength(5);
    expect(cleaned.events[0]).toMatchObject({
      title: EVENT.title, source: EVENT.source, event_at: "2026-11-25T13:30:00.000Z"
    });
    expect(cleaned.sources).toEqual([{ name: "BLS", status: "ok", checked_at: "2026-11-23T17:59:00.000Z" }]);
  });

  it("rejects unzoned times, unsafe links and invented source states", () => {
    const rows = [
      { ...EVENT, event_at: "2026-11-25T08:30:00" },
      { ...EVENT, url: "javascript:alert(1)" },
    ];
    const cleaned = calendar.clean({
      events: rows,
      sources: [{ name: "Rumor", status: "bullish" }],
    }, Date.parse("2026-11-23T18:00:00Z"));
    expect(cleaned.events).toEqual([]);
    expect(cleaned.sources).toEqual([]);
  });
});

describe("authenticated calendar receiver", () => {
  it("refuses missing setup and wrong credentials", async () => {
    await expect(calendar.receive(base, post({ events: [EVENT] }, "x"))).rejects.toMatchObject({ code: "calendar_not_set_up", status: 503 });
    await expect(calendar.receive(armed(), post({ events: [EVENT] }, "wrong"))).rejects.toMatchObject({ code: "bad_calendar_token", status: 401 });
  });

  it("stores events and reports late updates explicitly", async () => {
    const now = Date.parse("2026-11-23T18:00:00Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await calendar.receive(armed(), post({ checked_at: "2026-11-23T18:00:00Z", events: [EVENT], sources: [] }, "shared-secret"));
    expect(await calendar.current(base)).toMatchObject({ stale: false, events: [{ title: EVENT.title }] });
    clock.mockReturnValue(now + 7 * 60 * 60_000);
    expect(await calendar.current(base)).toMatchObject({ stale: true, age_minutes: 420 });
  });
});
