// SEC EDGAR 8-K watcher.
//
// Casey asked how to catch a news move. The honest finding behind this file is
// that he almost certainly cannot act fast enough for it to matter, and neither
// can we: on 17 November, Nvidia moved from $150.45 to $153.07 BEFORE CNBC
// published the statement that moved it. So this does not try to be fast. It
// tries to measure, by keeping three clocks on every filing:
//
//   accepted_at  the SEC's own acceptance time
//   received_at  when this hub first saw it
//   opened_at    when Casey first had it on screen
//
// After a couple of weeks those three numbers say what his real end-to-end delay
// is. If it is ten minutes, speed was never the game and the scheduled-event
// calendar is the better bet. If it is forty seconds, we know which leg to
// attack. Either way we will know instead of guessing, which is the only reason
// this is worth building before the strategy question is settled.

import type { Env } from "./util";
import { getSetting, setSetting } from "./db";

// EDGAR asks every automated caller to identify itself with a contact address and
// caps requests at 10 a second. The contact is configuration, never hard-coded:
// Casey's address is his to give out, not ours to put in a public repository.
const FEED = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&company=&dateb=&owner=include&count=100&output=atom";

// 8-K item codes worth waking up for. The rest are routine.
export const ITEMS_OF_INTEREST: Record<string, string> = {
  "1.01": "entered a material agreement",
  "1.03": "bankruptcy or receivership",
  "2.01": "completed an acquisition or disposal",
  "2.02": "reported results",
  "4.01": "changed accountants",
  "4.02": "said earlier financials cannot be relied on",
  "5.02": "an officer or director left or was appointed",
  "7.01": "regulation FD disclosure",
  "8.01": "other events the company chose to report",
};

export interface Filing {
  accession: string;
  cik: string;
  company: string;
  symbol: string | null;
  form: string;
  items: string | null;
  title: string;
  url: string;
  accepted_at: number;
}

const LAST_SEEN = "edgar_last_accession";
const LAST_RUN = "edgar_last_run";

/** Pull one tag's text out of an Atom entry. EDGAR's feed is small and regular. */
function tag(entry: string, name: string): string | null {
  const m = entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim() || null;
}

/**
 * Parse EDGAR's "recent filings" Atom feed.
 *
 * Pure, so it is testable without the network, which matters because the thing
 * most likely to break here is EDGAR changing its markup, not our scheduling.
 */
export function parseFeed(xml: string): Filing[] {
  const out: Filing[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = m[1];
    const url = entry.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? null;
    const title = tag(entry, "title");
    const updated = tag(entry, "updated");
    if (!url || !title || !updated) continue;

    const accepted = Date.parse(updated);
    if (!Number.isFinite(accepted)) continue;

    // Accession number is the stable identity, and it is in the URL.
    const accession = url.match(/(\d{10}-?\d{2}-?\d{6})/)?.[1]?.replace(/-/g, "") ?? null;
    const cik = url.match(/\/data\/(\d+)\//)?.[1] ?? null;
    if (!accession || !cik) continue;

    // EDGAR titles read "8-K - COMPANY NAME (0001045810) (Filer)".
    const form = title.match(/^([A-Z0-9/\-]+)\s*-\s*/)?.[1] ?? "8-K";
    const company = title.replace(/^[A-Z0-9/\-]+\s*-\s*/, "").replace(/\s*\(\d{7,}\)\s*\(.*?\)\s*$/, "").trim() || "Unknown filer";

    const summary = tag(entry, "summary") ?? "";
    const items = [...summary.matchAll(/\b(\d\.\d\d)\b/g)].map((x) => x[1]);

    out.push({
      accession, cik, company, symbol: null, form,
      items: items.length ? [...new Set(items)].join(",") : null,
      title, url, accepted_at: accepted,
    });
  }
  // Oldest first, so a run that is interrupted leaves the newest unrecorded and
  // the next run picks them up rather than skipping them.
  return out.sort((a, b) => a.accepted_at - b.accepted_at);
}

/** Plain words for an item code list. Unknown codes are passed through, not dropped. */
export function describeItems(items: string | null): string {
  if (!items) return "No item codes were listed.";
  const parts = items.split(",").map((c) => c.trim()).filter(Boolean);
  if (!parts.length) return "No item codes were listed.";
  const known = parts.map((c) => ITEMS_OF_INTEREST[c] ? `${c}, ${ITEMS_OF_INTEREST[c]}` : `${c}, not one we recognise`);
  return known.join(". ") + ".";
}

/** True when a filing carries at least one item code we care about. */
export function worthShowing(items: string | null): boolean {
  if (!items) return false;
  return items.split(",").some((c) => c.trim() in ITEMS_OF_INTEREST);
}

/**
 * Fetch and store new filings. Returns what was stored, newest first.
 *
 * Never throws at the caller: a scheduled run that dies silently is the failure
 * mode we spent today fixing, so a failure is recorded and surfaced instead.
 */
export async function poll(env: Env, now: number): Promise<{ stored: number; error: string | null }> {
  const contact = env.SEC_CONTACT;
  if (!contact) {
    const error = "SEC_CONTACT is not set, so EDGAR cannot be called. It must carry a contact address, which is Casey's to supply.";
    await setSetting(env, LAST_RUN, JSON.stringify({ at: now, ok: false, error }));
    return { stored: 0, error };
  }

  let filings: Filing[] = [];
  try {
    const res = await fetch(FEED, {
      headers: { "User-Agent": contact, "Accept-Encoding": "gzip, deflate" },
    });
    if (!res.ok) throw new Error(`EDGAR answered ${res.status}`);
    filings = parseFeed(await res.text());
  } catch (err) {
    const error = `Could not read EDGAR: ${err instanceof Error ? err.message : String(err)}`;
    await setSetting(env, LAST_RUN, JSON.stringify({ at: now, ok: false, error }));
    return { stored: 0, error };
  }

  const lastSeen = await getSetting(env, LAST_SEEN);
  let stored = 0, newest = lastSeen;
  for (const f of filings) {
    if (!worthShowing(f.items)) continue;
    const done = await env.DB.prepare(
      `INSERT OR IGNORE INTO filings (accession, cik, company, symbol, form, items, title, url, accepted_at, received_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(f.accession, f.cik, f.company, f.symbol, f.form, f.items, f.title, f.url, f.accepted_at, now).run();
    if (done.meta?.changes) stored++;
    newest = f.accession;
  }
  if (newest && newest !== lastSeen) await setSetting(env, LAST_SEEN, newest);
  await setSetting(env, LAST_RUN, JSON.stringify({ at: now, ok: true, error: null, seen: filings.length, stored }));
  return { stored, error: null };
}

export interface FilingsView {
  checked_at: number | null;
  ok: boolean;
  error: string | null;
  items: Array<Filing & { received_at: number; opened_at: number | null }>;
  /** Median seconds from SEC acceptance to this hub seeing it, over what we have. */
  median_pickup_seconds: number | null;
  /** Median seconds from acceptance to Casey opening it. Null until he has opened some. */
  median_to_casey_seconds: number | null;
  /** How many filings each median actually used. Not the row count: rows with a
   *  negative interval or no opened_at are excluded, and saying "median over 40"
   *  when it rested on 3 would overstate it. */
  measured_on: number;
  opened_on: number;
}

/** Everything the page needs, including the measurement this exists for. */
export async function view(env: Env, limit = 12): Promise<FilingsView> {
  const rows = await env.DB.prepare(
    `SELECT accession, cik, company, symbol, form, items, title, url, accepted_at, received_at, opened_at
       FROM filings ORDER BY accepted_at DESC LIMIT ?1`,
  ).bind(limit).all();

  const all = await env.DB.prepare(
    `SELECT accepted_at, received_at, opened_at FROM filings ORDER BY accepted_at DESC LIMIT 200`,
  ).all();

  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };

  const sample = (all.results ?? []) as unknown as Array<{ accepted_at: number; received_at: number; opened_at: number | null }>;
  const pickup = sample.map((r) => Math.round((r.received_at - r.accepted_at) / 1000)).filter((n) => n >= 0);
  const toCasey = sample.filter((r) => r.opened_at !== null)
    .map((r) => Math.round(((r.opened_at as number) - r.accepted_at) / 1000)).filter((n) => n >= 0);

  let checked_at: number | null = null, ok = false, error: string | null = null;
  const raw = await getSetting(env, LAST_RUN);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { at?: number; ok?: boolean; error?: string | null };
      checked_at = typeof parsed.at === "number" ? parsed.at : null;
      ok = parsed.ok === true;
      error = parsed.error ?? null;
    } catch { /* a corrupt record reads as never checked, which is honest */ }
  }

  return {
    checked_at, ok, error,
    items: (rows.results ?? []) as unknown as FilingsView["items"],
    median_pickup_seconds: median(pickup),
    median_to_casey_seconds: median(toCasey),
    measured_on: pickup.length,
    opened_on: toCasey.length,
  };
}

/**
 * Stamp the filings Casey has now seen. Only the owner's own page does this:
 * an AI reading the hub is not Casey looking at his phone, and counting it as
 * such would quietly corrupt the one number this whole file exists to produce.
 */
export async function markOpened(env: Env, accessions: string[], now: number): Promise<number> {
  const ids = accessions.filter((a) => /^\d{18}$/.test(a)).slice(0, 50);
  if (!ids.length) return 0;
  const marks = ids.map((_, i) => `?${i + 2}`).join(",");
  const done = await env.DB.prepare(
    `UPDATE filings SET opened_at = ?1 WHERE opened_at IS NULL AND accession IN (${marks})`,
  ).bind(now, ...ids).run();
  return done.meta?.changes ?? 0;
}
