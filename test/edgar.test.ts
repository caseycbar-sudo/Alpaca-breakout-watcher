import { describe, it, expect } from "vitest";
import { parseFeed, describeItems, worthShowing, ITEMS_OF_INTEREST } from "../src/edgar";

// The thing most likely to break here is EDGAR changing its markup, not our
// scheduling, so the parser is tested hard and offline. Shape copied from the
// real browse-edgar getcurrent Atom feed.
const entry = (over: Partial<Record<string, string>> = {}) => `
  <entry>
    <title>${over.title ?? "8-K - NVIDIA CORP (0001045810) (Filer)"}</title>
    <link rel="alternate" type="text/html" href="${over.href ?? "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000123/0001045810-26-000123-index.htm"}"/>
    <summary type="html">${over.summary ?? "Items&#13;&#10;Item 5.02 Departure of Directors"}</summary>
    <updated>${over.updated ?? "2026-11-12T13:31:00-05:00"}</updated>
  </entry>`;

const feed = (...entries: string[]) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join("")}</feed>`;

describe("reading EDGAR's filing feed", () => {
  it("pulls out the filing a reader would care about", () => {
    const [f] = parseFeed(feed(entry()));
    expect(f.accession).toBe("000104581026000123");
    expect(f.cik).toBe("1045810");
    expect(f.company).toBe("NVIDIA CORP");
    expect(f.form).toBe("8-K");
    expect(f.items).toBe("5.02");
    expect(f.accepted_at).toBe(Date.parse("2026-11-12T13:31:00-05:00"));
  });

  it("keeps the SEC's own acceptance time rather than the time we read it", () => {
    // The whole measurement rests on this clock being theirs, not ours.
    const [f] = parseFeed(feed(entry({ updated: "2026-11-12T09:00:00-05:00" })));
    expect(f.accepted_at).toBe(Date.parse("2026-11-12T14:00:00Z"));
  });

  it("returns oldest first, so an interrupted run loses nothing", () => {
    const out = parseFeed(feed(
      entry({ updated: "2026-11-12T15:00:00-05:00", href: "https://www.sec.gov/Archives/edgar/data/1/000000000026000002-index.htm" }),
      entry({ updated: "2026-11-12T13:00:00-05:00", href: "https://www.sec.gov/Archives/edgar/data/2/000000000026000001-index.htm" }),
    ));
    expect(out.map((f) => f.accession)).toEqual(["000000000026000001", "000000000026000002"]);
  });

  it("collects every item code, without repeats", () => {
    const [f] = parseFeed(feed(entry({ summary: "Item 2.02 Results. Item 7.01 Reg FD. Item 2.02 again." })));
    expect(f.items).toBe("2.02,7.01");
  });

  it("skips entries missing anything it needs rather than inventing it", () => {
    expect(parseFeed(feed("<entry><title>8-K - X</title></entry>"))).toHaveLength(0);
    expect(parseFeed(feed(entry({ updated: "not a date" })))).toHaveLength(0);
    expect(parseFeed(feed(entry({ href: "https://www.sec.gov/nothing-useful" })))).toHaveLength(0);
    expect(parseFeed("")).toHaveLength(0);
    expect(parseFeed("<feed></feed>")).toHaveLength(0);
  });

  it("unescapes the company name instead of showing raw entities", () => {
    const [f] = parseFeed(feed(entry({ title: "8-K - JOHNSON &amp; JOHNSON (0000200406) (Filer)" })));
    expect(f.company).toBe("JOHNSON & JOHNSON");
  });

  it("strips the CIK and role that EDGAR appends to every title", () => {
    const [f] = parseFeed(feed(entry({ title: "8-K/A - SOME SMALL CO INC (0001234567) (Filer)" })));
    expect(f.company).toBe("SOME SMALL CO INC");
    expect(f.form).toBe("8-K/A");
  });

  it("survives a filing with no item codes at all", () => {
    const [f] = parseFeed(feed(entry({ summary: "Filed by someone" })));
    expect(f.items).toBeNull();
    expect(worthShowing(f.items)).toBe(false);
  });
});

describe("deciding what is worth showing", () => {
  it("shows the codes that mean something happened", () => {
    expect(worthShowing("5.02")).toBe(true);     // an officer left
    expect(worthShowing("1.03")).toBe(true);     // bankruptcy
    expect(worthShowing("9.99,5.02")).toBe(true);
  });

  it("stays quiet on codes we do not recognise, and on none at all", () => {
    expect(worthShowing("9.01")).toBe(false);    // exhibits only
    expect(worthShowing(null)).toBe(false);
    expect(worthShowing("")).toBe(false);
  });
});

describe("explaining a filing in plain words", () => {
  it("says what the code means rather than printing the number alone", () => {
    expect(describeItems("5.02")).toContain("an officer or director left");
    expect(describeItems("4.02")).toContain("cannot be relied on");
  });

  it("passes an unknown code through instead of dropping or guessing it", () => {
    const text = describeItems("5.02,9.99");
    expect(text).toContain("an officer or director left");
    expect(text).toContain("9.99");
    expect(text).toContain("not one we recognise");
  });

  it("says so when there are none", () => {
    expect(describeItems(null)).toBe("No item codes were listed.");
    expect(describeItems("")).toBe("No item codes were listed.");
  });

  it("describes every code it claims to know", () => {
    for (const code of Object.keys(ITEMS_OF_INTEREST)) {
      expect(describeItems(code)).toContain(ITEMS_OF_INTEREST[code]);
    }
  });
});

// The measurement is the reason this file exists, so it is tested against a real
// database rather than a stub. Casey's whole decision about whether to chase
// speed rests on these three clocks being right.
import { env as rawEnv } from "cloudflare:workers";
import { view, markOpened } from "../src/edgar";
import type { Env } from "../src/util";

const env = rawEnv as unknown as Env;
const T = Date.parse("2026-11-23T18:00:00Z");

async function store(accession: string, acceptedAt: number, receivedAt: number, openedAt: number | null = null) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO filings (accession, cik, company, symbol, form, items, title, url, accepted_at, received_at, opened_at)
     VALUES (?1,'1','Test Co',NULL,'8-K','5.02','8-K - Test Co','https://sec.gov/x',?2,?3,?4)`,
  ).bind(accession, acceptedAt, receivedAt, openedAt).run();
}

describe("the three clocks", () => {
  it("measures pickup from the SEC's clock to ours, not from our own twice", async () => {
    await env.DB.prepare("DELETE FROM filings").run();
    await store("100000000000000001", T, T + 40_000);          // 40s to notice
    await store("100000000000000002", T, T + 60_000);          // 60s
    await store("100000000000000003", T, T + 200_000);         // 200s
    const v = await view(env);
    expect(v.median_pickup_seconds).toBe(60);
    expect(v.measured_on).toBe(3);
  });

  it("reports nothing for Casey's leg until he has actually opened something", async () => {
    await env.DB.prepare("DELETE FROM filings").run();
    await store("200000000000000001", T, T + 30_000);
    const before = await view(env);
    expect(before.median_to_casey_seconds).toBeNull();

    expect(await markOpened(env, ["200000000000000001"], T + 600_000)).toBe(1);
    const after = await view(env);
    expect(after.median_to_casey_seconds).toBe(600);
  });

  it("never restamps a filing Casey already opened, so the first look is the measurement", async () => {
    await env.DB.prepare("DELETE FROM filings").run();
    await store("300000000000000001", T, T + 10_000);
    await markOpened(env, ["300000000000000001"], T + 120_000);
    expect(await markOpened(env, ["300000000000000001"], T + 999_000)).toBe(0);
    expect((await view(env)).median_to_casey_seconds).toBe(120);
  });

  it("ignores anything that is not an accession number", async () => {
    await env.DB.prepare("DELETE FROM filings").run();
    await store("400000000000000001", T, T + 10_000);
    expect(await markOpened(env, ["'; DROP TABLE filings; --", "short", ""], T)).toBe(0);
    expect(await markOpened(env, [], T)).toBe(0);
    expect((await view(env)).items).toHaveLength(1);
  });

  it("leaves a clock out rather than reporting a negative delay", async () => {
    // Clock skew between the SEC and Cloudflare can put received before accepted.
    // A negative pickup is meaningless and would drag the median toward zero.
    await env.DB.prepare("DELETE FROM filings").run();
    await store("500000000000000001", T, T - 5_000);
    await store("500000000000000002", T, T + 50_000);
    expect((await view(env)).median_pickup_seconds).toBe(50);
  });

  it("says plainly when it has never run, instead of looking quietly healthy", async () => {
    await env.DB.prepare("DELETE FROM filings").run();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'edgar_last_run'").run();
    const v = await view(env);
    expect(v.checked_at).toBeNull();
    expect(v.ok).toBe(false);
    expect(v.items).toHaveLength(0);
    expect(v.median_pickup_seconds).toBeNull();
  });
});
