// Everything the hub knows how to do with its data. Both doors (Casey's page and
// the AI connector) call these same functions, so the rules are enforced in one place.
//
// Milestone 1 has no broker connection and no order capability. Nothing in this
// file can place, change or cancel an order anywhere.

import {
  type Actor,
  type Env,
  HubError,
  clampInt,
  now,
  numOrNull,
  ownerOnly,
  requireScope,
  textOrNull,
} from "./util";

export const STALE_AFTER_MINUTES = 120;
const MAX_MESSAGE = 8000;

/** Post a note from the hub itself, and hand the same words back to the caller. */
export async function hubSays(env: Env, body: string): Promise<string> {
  await env.DB.prepare(`INSERT INTO messages (author_kind, author_id, author_name, body, created_at) VALUES ('system','hub','Hub',?1,?2)`)
    .bind(body, Date.now())
    .run();
  return body;
}

// ---------------------------------------------------------------- settings

export async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`)
    .bind(key, value)
    .run();
}

// ---------------------------------------------------------------- presence

export async function touchAgent(env: Env, actor: Actor, action: string): Promise<void> {
  if (actor.kind !== "agent") return;
  await env.DB.prepare(
    `INSERT INTO agent_seen (agent_id, agent_name, last_seen, last_action) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(agent_id) DO UPDATE SET agent_name = ?2, last_seen = ?3, last_action = ?4`,
  )
    .bind(actor.id, actor.name, now(), action)
    .run();
}

export async function agentsSeen(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT agent_id, agent_name, last_seen, last_action FROM agent_seen ORDER BY last_seen DESC`,
  ).all<{ agent_id: string; agent_name: string; last_seen: number; last_action: string | null }>();
  return results;
}

// -------------------------------------------------------------------- chat

export interface MessageRow {
  id: number;
  author_kind: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
}

export async function postMessage(env: Env, actor: Actor, bodyIn: unknown, idemKey?: unknown): Promise<MessageRow> {
  requireScope(actor, "hub:chat");
  const body = String(bodyIn ?? "").trim();
  if (!body) throw new HubError(400, "empty_message", "The message is empty.");
  if (body.length > MAX_MESSAGE) {
    throw new HubError(400, "message_too_long", `Messages can be at most ${MAX_MESSAGE} characters. This one is ${body.length}.`);
  }
  const idem = textOrNull(idemKey, 200);
  const key = idem ? `${actor.id}:${idem}` : null;
  if (key) {
    const existing = await env.DB.prepare(`SELECT * FROM messages WHERE idem_key = ?1`).bind(key).first<MessageRow>();
    if (existing) return existing;
  }
  const created = now();
  const res = await env.DB.prepare(
    `INSERT INTO messages (author_kind, author_id, author_name, body, created_at, idem_key) VALUES (?1,?2,?3,?4,?5,?6)`,
  )
    .bind(actor.kind, actor.id, actor.name, body, created, key)
    .run();
  const id = Number(res.meta.last_row_id);
  // Posting implies you have seen everything up to your own message.
  await markRead(env, actor.id, id);
  await touchAgent(env, actor, "posted in chat");
  return { id, author_kind: actor.kind, author_id: actor.id, author_name: actor.name, body, created_at: created };
}

export async function markRead(env: Env, readerId: string, lastId: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO read_marks (reader_id, last_read_id, seen_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(reader_id) DO UPDATE SET last_read_id = MAX(last_read_id, ?2), seen_at = ?3`,
  )
    .bind(readerId, lastId, now())
    .run();
}

export async function unreadCount(env: Env, readerId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages
     WHERE id > COALESCE((SELECT last_read_id FROM read_marks WHERE reader_id = ?1), 0) AND author_id != ?1`,
  )
    .bind(readerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface ChatPage {
  messages: MessageRow[];
  /** Oldest first. */
  newest_id: number | null;
  oldest_id: number | null;
  has_older: boolean;
  has_newer: boolean;
  unread_before_this_read: number;
}

/**
 * Read a page of chat, oldest first.
 * - no cursor: the newest `limit` messages, and marks them read for this reader.
 * - after_id: messages newer than that id, in order (for catching up).
 * - before_id: messages older than that id (for scrolling back). Never marks read.
 */
export async function readChat(
  env: Env,
  actor: Actor,
  opts: { after_id?: unknown; before_id?: unknown; limit?: unknown; mark_read?: boolean } = {},
): Promise<ChatPage> {
  requireScope(actor, "hub:read");
  const limit = clampInt(opts.limit, 30, 1, 100);
  const after = numOrNull(opts.after_id);
  const before = numOrNull(opts.before_id);
  const unreadBefore = await unreadCount(env, actor.id);
  let rows: MessageRow[];
  if (after !== null) {
    const r = await env.DB.prepare(
      `SELECT id, author_kind, author_id, author_name, body, created_at FROM messages WHERE id > ?1 ORDER BY id ASC LIMIT ?2`,
    )
      .bind(after, limit + 1)
      .all<MessageRow>();
    rows = r.results;
  } else if (before !== null) {
    const r = await env.DB.prepare(
      `SELECT id, author_kind, author_id, author_name, body, created_at FROM messages WHERE id < ?1 ORDER BY id DESC LIMIT ?2`,
    )
      .bind(before, limit + 1)
      .all<MessageRow>();
    rows = r.results;
  } else {
    const r = await env.DB.prepare(
      `SELECT id, author_kind, author_id, author_name, body, created_at FROM messages ORDER BY id DESC LIMIT ?1`,
    )
      .bind(limit + 1)
      .all<MessageRow>();
    rows = r.results;
  }
  const more = rows.length > limit;
  if (more) rows = rows.slice(0, limit);
  if (after === null) rows.reverse(); // newest-first queries flip to oldest-first
  const newest = rows.length ? rows[rows.length - 1].id : null;
  const oldest = rows.length ? rows[0].id : null;

  const maxRow = await env.DB.prepare(`SELECT MAX(id) AS m, MIN(id) AS n FROM messages`).first<{ m: number | null; n: number | null }>();
  const has_newer = newest !== null && maxRow?.m != null && maxRow.m > newest;
  const has_older = oldest !== null && maxRow?.n != null && maxRow.n < oldest;

  if (opts.mark_read !== false && before === null && newest !== null) {
    await markRead(env, actor.id, newest);
  }
  await touchAgent(env, actor, "read the chat");
  return { messages: rows, newest_id: newest, oldest_id: oldest, has_older, has_newer, unread_before_this_read: unreadBefore };
}

// ------------------------------------------------------------------- rules

export interface RulesRow {
  version: number;
  created_at: number;
  max_per_trade: number;
  daily_trigger: number;
  max_positions: number;
  instruments: string;
  notes: string | null;
  change_note: string;
}

export async function currentRules(env: Env): Promise<RulesRow> {
  const row = await env.DB.prepare(`SELECT * FROM rules ORDER BY version DESC LIMIT 1`).first<RulesRow>();
  if (!row) throw new HubError(500, "no_rules", "No rules are stored.");
  return row;
}

export async function rulesHistory(env: Env): Promise<RulesRow[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM rules ORDER BY version DESC LIMIT 50`).all<RulesRow>();
  return results;
}

export async function newRulesVersion(env: Env, actor: Actor, input: Record<string, unknown>): Promise<RulesRow> {
  ownerOnly(actor, "change the rules");
  const maxPerTrade = numOrNull(input.max_per_trade);
  const dailyTrigger = numOrNull(input.daily_trigger);
  const maxPositions = numOrNull(input.max_positions);
  const instruments = textOrNull(input.instruments, 300);
  const changeNote = textOrNull(input.change_note, 1000);
  if (maxPerTrade === null || maxPerTrade <= 0) throw new HubError(400, "bad_rule", "Most per trade must be a dollar amount above zero.");
  if (dailyTrigger === null || dailyTrigger <= 0) throw new HubError(400, "bad_rule", "The daily stop must be a dollar amount above zero.");
  if (maxPositions === null || maxPositions < 1 || !Number.isInteger(maxPositions)) {
    throw new HubError(400, "bad_rule", "Positions at once must be a whole number of 1 or more.");
  }
  if (!instruments) throw new HubError(400, "bad_rule", "Say what may be traded, for example: Stocks and ETFs only.");
  if (!changeNote) throw new HubError(400, "bad_rule", "Add a short note saying why the rules are changing. It is kept in the history.");
  await env.DB.prepare(
    `INSERT INTO rules (created_at, max_per_trade, daily_trigger, max_positions, instruments, notes, change_note)
     VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  )
    .bind(now(), maxPerTrade, dailyTrigger, maxPositions, instruments, textOrNull(input.notes, 4000), changeNote)
    .run();
  const rules = await currentRules(env);
  await systemMessage(env, `Casey changed the rules. They are now version ${rules.version}: at most $${rules.max_per_trade} per trade, no new orders once down $${rules.daily_trigger} on the day, at most ${rules.max_positions} positions, ${rules.instruments}. Why: ${changeNote}`);
  return rules;
}

async function systemMessage(env: Env, body: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (author_kind, author_id, author_name, body, created_at) VALUES ('system','hub','Hub',?1,?2)`,
  )
    .bind(body, now())
    .run();
}

// --------------------------------------------------------------- snapshots

export interface PositionIn {
  symbol: string;
  quantity: number;
  average_cost: number | null;
  market_value: number | null;
}
export interface OrderIn {
  symbol: string;
  side: "buy" | "sell";
  type: string;
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
  status: string | null;
  broker_order_id: string | null;
}

function cleanPositions(input: unknown): PositionIn[] | null {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) throw new HubError(400, "bad_snapshot", "positions must be a list, or left out when positions were not checked.");
  if (input.length > 100) throw new HubError(400, "bad_snapshot", "A snapshot can hold at most 100 positions.");
  return input.map((p, i) => {
    const symbol = textOrNull((p as any)?.symbol, 20)?.toUpperCase();
    const quantity = numOrNull((p as any)?.quantity);
    if (!symbol || quantity === null) throw new HubError(400, "bad_snapshot", `Position ${i + 1} needs a symbol and a quantity.`);
    return { symbol, quantity, average_cost: numOrNull((p as any).average_cost), market_value: numOrNull((p as any).market_value) };
  });
}

function cleanOrders(input: unknown): OrderIn[] | null {
  if (input === null || input === undefined) return null;
  if (!Array.isArray(input)) throw new HubError(400, "bad_snapshot", "open_orders must be a list, or left out when orders were not checked.");
  if (input.length > 100) throw new HubError(400, "bad_snapshot", "A snapshot can hold at most 100 open orders.");
  return input.map((o, i) => {
    const symbol = textOrNull((o as any)?.symbol, 20)?.toUpperCase();
    const side = String((o as any)?.side ?? "").toLowerCase();
    const quantity = numOrNull((o as any)?.quantity);
    if (!symbol || (side !== "buy" && side !== "sell") || quantity === null) {
      throw new HubError(400, "bad_snapshot", `Open order ${i + 1} needs a symbol, a side of "buy" or "sell", and a quantity.`);
    }
    return {
      symbol,
      side: side as "buy" | "sell",
      type: String((o as any).type ?? "unknown").toLowerCase().slice(0, 30),
      quantity,
      limit_price: numOrNull((o as any).limit_price),
      stop_price: numOrNull((o as any).stop_price),
      status: textOrNull((o as any).status, 60),
      broker_order_id: textOrNull((o as any).broker_order_id, 120),
    };
  });
}

export async function postSnapshot(env: Env, actor: Actor, input: Record<string, unknown>) {
  requireScope(actor, "hub:snapshot");
  const source = textOrNull(input.source, 200);
  if (!source) throw new HubError(400, "bad_snapshot", `Say where the numbers came from in "source", for example "Robinhood agent connection".`);
  const uploaded = now();
  let observed = uploaded;
  if (input.observed_at !== undefined && input.observed_at !== null && input.observed_at !== "") {
    const t = typeof input.observed_at === "number" ? input.observed_at : Date.parse(String(input.observed_at));
    if (!Number.isFinite(t)) throw new HubError(400, "bad_snapshot", "observed_at must be a time, for example 2026-11-17T14:30:00Z.");
    if (t > uploaded + 5 * 60_000) throw new HubError(400, "bad_snapshot", "observed_at is in the future.");
    observed = t;
  }
  const positions = cleanPositions(input.positions);
  const orders = cleanOrders(input.open_orders);
  let completeness = String(input.completeness ?? "").toLowerCase();
  if (!["complete", "partial", "unknown"].includes(completeness)) {
    completeness = positions !== null && orders !== null && numOrNull(input.cash) !== null ? "complete" : "partial";
  }
  const idem = textOrNull(input.idempotency_key, 200);
  const key = idem ? `${actor.id}:${idem}` : null;
  if (key) {
    const existing = await env.DB.prepare(`SELECT id FROM snapshots WHERE idem_key = ?1`).bind(key).first<{ id: number }>();
    if (existing) return { id: existing.id, duplicate: true };
  }
  const res = await env.DB.prepare(
    `INSERT INTO snapshots (author_id, author_name, source, observed_at, uploaded_at, completeness, total_value, cash,
                            buying_power, day_change, positions, open_orders, note, idem_key)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  )
    .bind(
      actor.id, actor.name, source, observed, uploaded, completeness,
      numOrNull(input.total_value), numOrNull(input.cash), numOrNull(input.buying_power), numOrNull(input.day_change),
      positions === null ? null : JSON.stringify(positions),
      orders === null ? null : JSON.stringify(orders),
      textOrNull(input.note, 2000), key,
    )
    .run();
  await touchAgent(env, actor, "reported an account snapshot");
  return { id: Number(res.meta.last_row_id), duplicate: false };
}

interface SnapshotRow {
  id: number;
  author_id: string;
  author_name: string;
  source: string;
  observed_at: number;
  uploaded_at: number;
  completeness: string;
  total_value: number | null;
  cash: number | null;
  buying_power: number | null;
  day_change: number | null;
  positions: string | null;
  open_orders: string | null;
  note: string | null;
}

export type Coverage = "confirmed" | "partial" | "none" | "unknown";

/** Pure: how much of a position is covered by resting sell stops. Tested directly. */
export function coverageFor(position: PositionIn, orders: OrderIn[] | null): { coverage: Coverage; covered_quantity: number | null } {
  if (orders === null) return { coverage: "unknown", covered_quantity: null };
  const covered = orders
    .filter((o) => o.symbol === position.symbol && o.side === "sell" && o.type.includes("stop"))
    .reduce((sum, o) => sum + o.quantity, 0);
  const EPS = 1e-9;
  if (covered <= EPS) return { coverage: "none", covered_quantity: 0 };
  if (covered + EPS >= position.quantity) return { coverage: "confirmed", covered_quantity: covered };
  return { coverage: "partial", covered_quantity: covered };
}

export interface BoardException {
  level: "stop" | "warn";
  text: string;
}

export async function buildBoard(env: Env, at = now()) {
  const rules = await currentRules(env);
  const snap = await env.DB.prepare(`SELECT * FROM snapshots ORDER BY observed_at DESC, id DESC LIMIT 1`).first<SnapshotRow>();
  const exceptions: BoardException[] = [];
  const historicalNotices: Array<{ text: string }> = [];
  const historicalDetails: Array<{ text: string }> = [];
  let snapshot: Record<string, unknown> | null = null;
  // Symbols the broker snapshot has already flagged as unprotected. An existing
  // holding would otherwise warn about the same missing stop a second time, and
  // the snapshot's version is the better evidence: it comes from the account.
  const noStopFromBroker = new Set<string>();

  if (!snap) {
    exceptions.push({ level: "warn", text: "No account snapshot has been reported yet, so the account numbers are blank." });
  } else {
    const ageMinutes = Math.max(0, Math.round((at - snap.observed_at) / 60_000));
    const stale = ageMinutes > STALE_AFTER_MINUTES;
    const positions: PositionIn[] | null = snap.positions ? JSON.parse(snap.positions) : null;
    const orders: OrderIn[] | null = snap.open_orders ? JSON.parse(snap.open_orders) : null;
    const positionsOut = positions?.map((p) => ({ ...p, ...coverageFor(p, orders) })) ?? null;
    const openBuyExposure =
      orders === null
        ? null
        : orders
            .filter((o) => o.side === "buy")
            .reduce((sum, o) => sum + o.quantity * (o.limit_price ?? o.stop_price ?? 0), 0);
    const bpOverCash =
      snap.cash !== null && snap.buying_power !== null ? snap.buying_power > snap.cash + 0.005 : null;
    const triggerReached = snap.day_change !== null ? snap.day_change <= -rules.daily_trigger : null;

    if (stale) {
      exceptions.push({
        level: "warn",
        text: `The account numbers are ${describeAge(ageMinutes)} old. Treat them as out of date until an AI reports a new snapshot.`,
      });
    }
    if (snap.completeness !== "complete") {
      exceptions.push({
        level: "warn",
        text:
          snap.completeness === "partial"
            ? "The last snapshot was only partly filled in. Anything shown as “not reported” was not checked."
            : "The last snapshot did not say how complete it was.",
      });
    }
    if (bpOverCash) {
      exceptions.push({ level: "stop", text: "Buying power is higher than cash. That can mean borrowed money is available. Check the account before any new order." });
    }
    if (triggerReached) {
      exceptions.push({ level: "stop", text: `The account was down $${Math.abs(snap.day_change!).toFixed(2)} on the day at the last check, which reaches the $${rules.daily_trigger} daily stop. No new orders today.` });
    }
    const historicalSymbols = new Set<string>();
    if (positionsOut) {
      if (positionsOut.length > rules.max_positions) {
        exceptions.push({ level: "stop", text: `There are ${positionsOut.length} positions open and the rules allow ${rules.max_positions}.` });
      }
      for (const p of positionsOut) {
        if (p.coverage === "none") exceptions.push({ level: "warn", text: `${p.symbol} has no stop order protecting it.` });
        if (p.coverage === "partial") exceptions.push({ level: "warn", text: `${p.symbol} is only partly covered by a stop order.` });
        if (p.coverage === "none" || p.coverage === "partial") noStopFromBroker.add(String(p.symbol).toUpperCase());
      }
    }
    // Keep each reporter/source history separate. A new connection cannot silently
    // clear another connection's warning, nor establish that their accounts match.
    const priorReports = await env.DB.prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY author_id, source ORDER BY observed_at DESC, id DESC
         ) AS history_rank
         FROM snapshots WHERE positions IS NOT NULL AND open_orders IS NOT NULL
         AND (observed_at < ?1 OR (observed_at = ?1 AND id <= ?2))
       ) WHERE history_rank = 1 ORDER BY observed_at DESC, id DESC`,
    ).bind(snap.observed_at, snap.id).all<SnapshotRow>();
    for (const prior of priorReports.results) {
      const sameConnection = prior.author_id === snap.author_id && prior.source === snap.source;
      // Current complete reports already have their own per-symbol coverage warnings.
      if (sameConnection && positions !== null && orders !== null) continue;
      const priorPositions = JSON.parse(prior.positions!) as PositionIn[];
      const priorOrders = JSON.parse(prior.open_orders!) as OrderIn[];
      const unresolved = priorPositions.filter(p => ["none", "partial"].includes(coverageFor(p, priorOrders).coverage));
      if (!unresolved.length) continue;
      // Only evidence from this history's own reporter/source may retire its warnings.
      // These lists never become the current holdings/orders or affect slot capacity.
      const [latestHoldings, latestOrders] = await Promise.all([
        env.DB.prepare(
          `SELECT positions FROM snapshots WHERE positions IS NOT NULL
           AND author_id = ?3 AND source = ?4
           AND (observed_at < ?1 OR (observed_at = ?1 AND id <= ?2))
           ORDER BY observed_at DESC, id DESC LIMIT 1`,
        ).bind(snap.observed_at, snap.id, prior.author_id, prior.source).first<{ positions: string }>(),
        env.DB.prepare(
          `SELECT * FROM snapshots WHERE open_orders IS NOT NULL
           AND author_id = ?3 AND source = ?4
           AND (observed_at < ?1 OR (observed_at = ?1 AND id <= ?2))
           ORDER BY observed_at DESC, id DESC LIMIT 1`,
        ).bind(snap.observed_at, snap.id, prior.author_id, prior.source).first<SnapshotRow>(),
      ]);
      const lastReportedPositions: PositionIn[] = JSON.parse(latestHoldings!.positions);
      const laterOrders: OrderIn[] = JSON.parse(latestOrders!.open_orders!);
      const ordersAreLater = latestOrders!.observed_at > prior.observed_at ||
        (latestOrders!.observed_at === prior.observed_at && latestOrders!.id > prior.id);
      const terminal = new Set(["canceled", "cancelled", "filled", "rejected", "expired", "failed", "voided"]);
      const age = describeAge(Math.max(0, Math.round((at - prior.observed_at) / 60_000)));
      for (const position of unresolved) {
        if (!lastReportedPositions.some(p => p.symbol === position.symbol)) continue;
        const coverage = coverageFor(position, priorOrders).coverage;
        const hasLaterStop = ordersAreLater && laterOrders.some(o => o.symbol === position.symbol &&
          o.side === "sell" && o.type.includes("stop") && o.quantity > 0 && !terminal.has((o.status ?? "").toLowerCase()));
        const laterEvidence = hasLaterStop
          ? ` A later report in that same history includes a sell stop for ${position.symbol}: snapshot #${latestOrders!.id} at ${new Date(latestOrders!.observed_at).toISOString()}. This does not confirm current quantities or coverage.`
          : "";
        const currentUncertainty = sameConnection
          ? `The latest report omits ${positions === null && orders === null ? "positions and open orders" : positions === null ? "positions" : "open orders"}; current protection is unknown.`
          : "This is from a different reporter/source connection and may not be the same account; it does not establish current protection or holdings.";
        const quietHistory = !sameConnection && at - prior.observed_at > 72 * 60 * 60 * 1000;
        const historicalText = `Unresolved historical report: ${position.symbol} ${coverage === "none" ? "had no stop protection" : "had only partial stop protection"} ` +
            `in snapshot #${prior.id}, reported by ${prior.author_name} from ${prior.source} at ${new Date(prior.observed_at).toISOString()} (${age} ago). ` +
            currentUncertainty + laterEvidence + " Account identity is not recorded; reconciliation stays within each reporter/source history.";
        // Age changes display priority only; it does not resolve a protection concern.
        if (quietHistory) historicalNotices.push({ text: historicalText });
        else {
          historicalDetails.push({ text: historicalText });
          if (!historicalSymbols.has(position.symbol)) {
            exceptions.push({ level: "warn", text: `${position.symbol}: earlier report (${age} ago) showed ${coverage === "none" ? "no stop" : "partial stop coverage"}. ${sameConnection ? "Current protection unknown." : "Account match unverified."} See historical details.` });
          }
          historicalSymbols.add(position.symbol);
        }
      }
    }
    // Combine historical context and current uncertainty into one warning per symbol.
    for (const p of positionsOut ?? []) {
      if (p.coverage === "unknown" && !historicalSymbols.has(p.symbol)) {
        exceptions.push({ level: "warn", text: `${p.symbol}: open orders were not reported, so whether it has a stop is unknown.` });
      }
    }
    snapshot = {
      id: snap.id,
      reported_by: snap.author_name,
      source: snap.source,
      observed_at: snap.observed_at,
      uploaded_at: snap.uploaded_at,
      age_minutes: ageMinutes,
      age_words: describeAge(ageMinutes),
      stale,
      stale_after_minutes: STALE_AFTER_MINUTES,
      completeness: snap.completeness,
      total_value: snap.total_value,
      cash: snap.cash,
      buying_power: snap.buying_power,
      buying_power_exceeds_cash: bpOverCash,
      day_change: snap.day_change,
      daily_trigger_reached: triggerReached,
      positions: positionsOut,
      position_count: positionsOut ? positionsOut.length : null,
      open_orders: orders,
      open_buy_exposure: openBuyExposure,
      note: snap.note,
    };
  }

  const loose = await env.DB.prepare(
    `SELECT id, symbol, record_kind, review_state, order_state, protection_state FROM plans
     WHERE (order_state NOT IN ('none','closed','rejected','expired','canceled') AND review_state != 'authorized')
        OR (order_state IN ('filled','partially_filled') AND protection_state != 'confirmed')
        OR (record_kind = 'existing_holding' AND order_state != 'closed' AND protection_state != 'confirmed')`,
  ).all<{ id: string; symbol: string; record_kind: string; review_state: string; order_state: string; protection_state: string }>();
  for (const p of loose.results) {
    // An existing holding was bought outside the hub, so there is no order here
    // for Casey to have approved and nothing to call unapproved. Saying otherwise
    // put a red stop on the board for a position he already owned. See job #15.
    const bought = p.record_kind !== "existing_holding";
    if (bought && p.review_state !== "authorized" && !["none", "closed", "rejected", "expired", "canceled"].includes(p.order_state)) {
      exceptions.push({ level: "stop", text: `Plan ${p.id} (${p.symbol}) has an order recorded but Casey has not approved the plan.` });
    }
    if (bought && ["filled", "partially_filled"].includes(p.order_state) && p.protection_state !== "confirmed") {
      exceptions.push({ level: "warn", text: `Plan ${p.id} (${p.symbol}) has filled and its stop is not confirmed yet.` });
    }
    // The missing stop is the real risk, and it survives the reclassification.
    // Only the duplicate is dropped: when the broker snapshot already said this
    // symbol is unprotected, that line is on the board and says it better.
    if (!bought && p.order_state !== "closed" && p.protection_state !== "confirmed" && !noStopFromBroker.has(p.symbol.toUpperCase())) {
      // Keyed by symbol, so two records of the same holding say it once.
      noStopFromBroker.add(p.symbol.toUpperCase());
      exceptions.push({ level: "warn", text: `${p.symbol} is recorded as already owned and its stop is not confirmed yet.` });
    }
  }

  return {
    as_of: at,
    connections: {
      broker: "none",
      broker_words: "The hub has no live connection to Robinhood. Account numbers are reported by an AI and can be out of date.",
      engine: "none",
      engine_words: "No trading engine is running. Nothing here can place an order.",
    },
    rules: {
      version: rules.version,
      max_per_trade: rules.max_per_trade,
      daily_trigger: rules.daily_trigger,
      daily_trigger_words: "Checked when an AI reports a snapshot or before an order. It is not watched continuously, so it limits new orders but does not cap a day's loss.",
      max_positions: rules.max_positions,
      instruments: rules.instruments,
      slots_left: snapshot && typeof snapshot.position_count === "number" ? Math.max(0, rules.max_positions - (snapshot.position_count as number)) : null,
    },
    snapshot,
    exceptions: exceptions.sort((a, b) => a.level === b.level ? 0 : a.level === "stop" ? -1 : 1),
    historical_details: historicalDetails,
    historical_notices: historicalNotices,
  };
}

export function describeAge(minutes: number): string {
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

export async function snapshotHistory(env: Env, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT id, author_name, source, observed_at, uploaded_at, completeness, total_value, cash, buying_power, day_change, note
     FROM snapshots ORDER BY observed_at DESC, id DESC LIMIT ?1`,
  )
    .bind(clampInt(limit, 20, 1, 100))
    .all();
  return results;
}

// ------------------------------------------------------------------- plans

export interface PlanRow {
  id: string;
  created_at: number;
  updated_at: number;
  author_id: string;
  author_name: string;
  symbol: string;
  what_we_see: string;
  why: string | null;
  entry_price: number | null;
  target_price: number | null;
  stop_price: number | null;
  size_dollars: number | null;
  est_loss_at_stop: number | null;
  wrong_if: string | null;
  good_until: string | null;
  sources: string | null;
  rules_version: number | null;
  review_state: string;
  reviewed_by: string | null;
  review_comment: string | null;
  order_state: string;
  protection_state: string;
  broker_status: string | null;
  broker_order_ids: string | null;
  filled_quantity: number | null;
  fill_price: number | null;
  exit_price: number | null;
  fees: number | null;
  result_dollars: number | null;
  expected_vs_happened: string | null;
  lesson: string | null;
  record_kind: string;
  quantity: number | null;
  average_cost: number | null;
  observed_at: number | null;
  observed_source: string | null;
}

const MATERIAL = ["symbol", "entry_price", "target_price", "stop_price", "size_dollars"] as const;
const RECORD_KINDS = ["trade_plan", "existing_holding"];
const ORDER_STATES = ["none", "submission_pending", "working", "partially_filled", "filled", "rejected", "expired", "canceled", "unknown", "closed"];
const PROTECTION_STATES = ["not_applicable", "pending", "confirmed", "degraded", "unknown"];

async function planEvent(env: Env, planId: string, actor: Actor, action: string, detail?: unknown): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO plan_events (plan_id, at, actor_kind, actor_id, actor_name, action, detail) VALUES (?1,?2,?3,?4,?5,?6,?7)`,
  )
    .bind(planId, now(), actor.kind, actor.id, actor.name, action, detail === undefined ? null : JSON.stringify(detail))
    .run();
}

export async function getPlan(env: Env, actor: Actor, id: unknown) {
  requireScope(actor, "hub:read");
  const plan = await env.DB.prepare(`SELECT * FROM plans WHERE id = ?1`).bind(String(id ?? "")).first<PlanRow>();
  if (!plan) throw new HubError(404, "no_such_plan", `There is no plan with the id "${id}".`);
  const { results: history } = await env.DB.prepare(
    `SELECT at, actor_name, action, detail FROM plan_events WHERE plan_id = ?1 ORDER BY id ASC LIMIT 200`,
  )
    .bind(plan.id)
    .all();
  return { plan, history };
}

export async function listPlans(env: Env, actor: Actor, opts: { filter?: unknown; limit?: unknown; before?: unknown } = {}) {
  requireScope(actor, "hub:read");
  const limit = clampInt(opts.limit, 25, 1, 100);
  const filter = String(opts.filter ?? "all");
  const before = numOrNull(opts.before);
  const where: string[] = [];
  if (filter === "open") where.push(`order_state NOT IN ('closed','rejected','expired','canceled') AND review_state != 'declined'`);
  if (filter === "needs_review") where.push(`review_state = 'draft'`);
  if (filter === "needs_casey") where.push(`review_state = 'reviewed'`);
  if (filter === "closed") where.push(`order_state = 'closed'`);
  if (before !== null) where.push(`created_at < ${Math.trunc(before)}`);
  const sql = `SELECT * FROM plans ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?1`;
  const { results } = await env.DB.prepare(sql).bind(limit + 1).all<PlanRow>();
  const more = results.length > limit;
  const plans = more ? results.slice(0, limit) : results;
  return { plans, has_more: more, next_before: more ? plans[plans.length - 1].created_at : null };
}

export async function savePlan(env: Env, actor: Actor, input: Record<string, unknown>) {
  requireScope(actor, "hub:log");
  const rules = await currentRules(env);
  const id = textOrNull(input.id, 60);
  const existing = id ? await env.DB.prepare(`SELECT * FROM plans WHERE id = ?1`).bind(id).first<PlanRow>() : null;
  const stamp = now();

  const kind = input.record_kind !== undefined ? String(input.record_kind) : existing?.record_kind ?? "trade_plan";
  if (!RECORD_KINDS.includes(kind)) {
    throw new HubError(400, "bad_plan", `record_kind must be one of: ${RECORD_KINDS.join(", ")}.`);
  }
  // A holding bought outside the hub has no fill here. Its cost is an average over
  // however many buys the broker shows, and putting that number in fill_price made
  // it read as a single broker fill that never happened. See job #15.
  if (kind === "existing_holding" && numOrNull(input.fill_price) !== null) {
    throw new HubError(400, "bad_plan", "An existing holding has no fill price from this hub. Put the broker's average cost in average_cost instead.");
  }

  const size = input.size_dollars !== undefined ? numOrNull(input.size_dollars) : existing?.size_dollars ?? null;
  if (size !== null && size > rules.max_per_trade + 1e-9) {
    throw new HubError(
      400,
      "over_limit",
      `This plan is $${size} and the rules (version ${rules.version}) allow at most $${rules.max_per_trade} per trade. Only Casey can change that limit.`,
    );
  }
  if (size !== null && size <= 0) throw new HubError(400, "bad_plan", "size_dollars must be above zero.");

  const orderState = input.order_state !== undefined ? String(input.order_state) : undefined;
  const protState = input.protection_state !== undefined ? String(input.protection_state) : undefined;
  if (orderState !== undefined && !ORDER_STATES.includes(orderState)) {
    throw new HubError(400, "bad_plan", `order_state must be one of: ${ORDER_STATES.join(", ")}.`);
  }
  if (protState !== undefined && !PROTECTION_STATES.includes(protState)) {
    throw new HubError(400, "bad_plan", `protection_state must be one of: ${PROTECTION_STATES.join(", ")}.`);
  }
  if ("review_state" in input) {
    throw new HubError(400, "bad_plan", "review_state cannot be set here. Use review_plan to review, and Casey approves from his page.");
  }

  if (!existing) {
    const symbol = textOrNull(input.symbol, 20)?.toUpperCase();
    const see = textOrNull(input.what_we_see, 2000);
    if (!symbol) throw new HubError(400, "bad_plan", "A new plan needs a symbol.");
    if (!see) throw new HubError(400, "bad_plan", `A new plan needs "what_we_see": one or two plain sentences on what you noticed.`);
    const newId = id ?? (await nextPlanId(env, stamp));
    await env.DB.prepare(
      `INSERT INTO plans (id, created_at, updated_at, author_id, author_name, symbol, what_we_see, why, entry_price, target_price,
                          stop_price, size_dollars, est_loss_at_stop, wrong_if, good_until, sources, rules_version,
                          record_kind, quantity, average_cost, observed_at, observed_source)
       VALUES (?1,?2,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)`,
    )
      .bind(
        newId, stamp, actor.id, actor.name, symbol, see, textOrNull(input.why, 2000),
        numOrNull(input.entry_price), numOrNull(input.target_price), numOrNull(input.stop_price), size,
        numOrNull(input.est_loss_at_stop), textOrNull(input.wrong_if, 1000), textOrNull(input.good_until, 60),
        textOrNull(input.sources, 2000), rules.version,
        kind, numOrNull(input.quantity), numOrNull(input.average_cost),
        numOrNull(input.observed_at), textOrNull(input.observed_source, 500),
      )
      .run();
    await planEvent(env, newId, actor, kind === "existing_holding" ? "recorded a holding Casey already owned" : "created the plan");
    await touchAgent(env, actor, kind === "existing_holding" ? `recorded holding ${newId}` : `drafted plan ${newId}`);
    return { ...(await getPlan(env, actor, newId)), created: true, review_reset: false };
  }

  // Update. Work out what actually changes.
  const textFields = ["what_we_see", "why", "wrong_if", "good_until", "sources", "broker_status", "broker_order_ids", "expected_vs_happened", "lesson", "observed_source"] as const;
  const numFields = ["entry_price", "target_price", "stop_price", "size_dollars", "est_loss_at_stop", "filled_quantity", "fill_price", "exit_price", "fees", "result_dollars", "quantity", "average_cost", "observed_at"] as const;
  const changes: Record<string, unknown> = {};
  if (kind !== existing.record_kind) {
    // Calling an existing record a holding takes the "Casey has not approved this
    // order" stop off the board. My first answer was to announce it in chat, which
    // records the change without preventing it: any AI could still clear a flag on
    // a real order and leave a note saying it had. ChatGPT was right that an audit
    // trail is not a permission check. So the conversion is Casey's, both ways.
    // Creating a holding, reviewing one and updating what the broker shows all stay
    // open to the AIs, because none of those can silence a flag on someone's order.
    if (actor.kind !== "owner") {
      throw new HubError(
        403,
        "owner_only",
        `Only Casey can change what kind of record ${existing.id} is. Recording a new holding, reviewing one, or updating its quantity and average cost are open to you; turning an order already on the board into a holding is not.`,
      );
    }
    changes.record_kind = kind;
    // Reclassifying a mis-filed record has to clear what the old kind recorded,
    // or an average cost stays behind in fill_price and still reads as a fill.
    if (kind === "existing_holding" && existing.fill_price !== null) changes.fill_price = null;
  }
  if (input.symbol !== undefined) {
    const s = textOrNull(input.symbol, 20)?.toUpperCase();
    if (!s) throw new HubError(400, "bad_plan", "symbol cannot be empty.");
    if (s !== existing.symbol) changes.symbol = s;
  }
  for (const f of textFields) {
    if (input[f] !== undefined) {
      const v = textOrNull(input[f], 2000);
      if (f === "what_we_see" && !v) throw new HubError(400, "bad_plan", "what_we_see cannot be empty.");
      if (v !== (existing as any)[f]) changes[f] = v;
    }
  }
  for (const f of numFields) {
    if (input[f] !== undefined) {
      const v = numOrNull(input[f]);
      if (v !== (existing as any)[f]) changes[f] = v;
    }
  }
  if (orderState !== undefined && orderState !== existing.order_state) changes.order_state = orderState;
  if (protState !== undefined && protState !== existing.protection_state) changes.protection_state = protState;

  if (Object.keys(changes).length === 0) return { ...(await getPlan(env, actor, existing.id)), created: false, review_reset: false };

  // A review is a check of a specific set of facts. Change the facts and the old
  // verdict no longer describes anything that exists. Two cases beyond price and
  // size, both from ChatGPT's review: a record that changes kind would otherwise
  // carry a trade plan's approval onto a holding, or a holding's check onto a
  // trade plan, which would read as approval to buy; and a holding whose quantity
  // or average cost moved would keep a reviewer's acceptance of the old numbers.
  const HOLDING_FACTS = ["quantity", "average_cost", "observed_at", "observed_source"] as const;
  const kindChanged = "record_kind" in changes;
  const holdingFactsChanged = kind === "existing_holding" && HOLDING_FACTS.some((f) => f in changes);
  const materialChanged = MATERIAL.some((f) => f in changes) || kindChanged || holdingFactsChanged;
  const contentOnly = Object.keys(changes).some((f) => ["what_we_see", "why", "wrong_if", "good_until", "sources", ...MATERIAL].includes(f));
  if (contentOnly && actor.kind === "agent" && actor.id !== existing.author_id && existing.order_state === "none") {
    // Another AI may add outcome and order details, but the idea itself belongs to its author.
    throw new HubError(403, "not_author", `Only ${existing.author_name}, who wrote plan ${existing.id}, can change the idea itself. You can review it with review_plan.`);
  }
  let reviewReset = false;
  if (materialChanged && ["reviewed", "authorized", "objected"].includes(existing.review_state)) {
    changes.review_state = "draft";
    changes.reviewed_by = null;
    changes.review_comment = null;
    reviewReset = true;
  }
  changes.rules_version = rules.version;

  const cols = Object.keys(changes);
  const sql = `UPDATE plans SET ${cols.map((c, i) => `${c} = ?${i + 2}`).join(", ")}, updated_at = ?${cols.length + 2} WHERE id = ?1`;
  await env.DB.prepare(sql)
    .bind(existing.id, ...cols.map((c) => changes[c] as any), stamp)
    .run();
  await planEvent(env, existing.id, actor, reviewReset ? "changed the plan, so review and approval start over" : "updated the plan", changes);
  if (reviewReset) {
    const what = kindChanged
      ? "changed what kind of record"
      : holdingFactsChanged
        ? "changed the quantity, average cost or observation behind"
        : "changed the price, size or symbol on";
    await systemMessage(env, `${actor.name} ${what} ${existing.id} (${existing.symbol}). Its review and Casey's approval no longer apply and it needs a fresh review.`);
  }
  // Only Casey can get here, and the announcement stays anyway: the other AIs are
  // reading the same board and need to know why a flag moved. Both directions, so
  // a holding turned back into a trade plan is just as visible.
  if (kindChanged) {
    await systemMessage(
      env,
      changes.record_kind === "existing_holding"
        ? `Casey recorded ${existing.id} (${existing.symbol}) as a holding he already owned, not an order placed through the hub. ` +
            `The board will stop asking him to approve it. It needs a fresh review before it counts as checked.`
        : `Casey changed ${existing.id} (${existing.symbol}) back to a trade plan. ` +
            `Any review it had as a holding no longer applies and is not approval to buy anything.`,
    );
  }
  await touchAgent(env, actor, `updated plan ${existing.id}`);
  return { ...(await getPlan(env, actor, existing.id)), created: false, review_reset: reviewReset };
}

async function nextPlanId(env: Env, stamp: number): Promise<string> {
  const day = new Date(stamp).toISOString().slice(0, 10);
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM plans WHERE id LIKE ?1`).bind(`${day}-%`).first<{ n: number }>();
  let n = (row?.n ?? 0) + 1;
  for (;;) {
    const candidate = `${day}-${n}`;
    const clash = await env.DB.prepare(`SELECT 1 AS x FROM plans WHERE id = ?1`).bind(candidate).first();
    if (!clash) return candidate;
    n++;
  }
}

export async function reviewPlan(env: Env, actor: Actor, input: Record<string, unknown>) {
  requireScope(actor, "hub:log");
  const { plan } = await getPlan(env, actor, input.id);
  const verdict = String(input.verdict ?? "");
  const comment = textOrNull(input.comment, 2000);
  if (verdict !== "reviewed" && verdict !== "objected") throw new HubError(400, "bad_review", `verdict must be "reviewed" or "objected".`);
  if (actor.id === plan.author_id) {
    throw new HubError(403, "own_plan", "A plan cannot be reviewed by the one who wrote it. Another AI or Casey has to look at it.");
  }
  // "Too late" means an order is already out and a review cannot change it. An
  // existing holding never had an order here, so there is nothing to be late for,
  // and blocking it left Casey's two real positions unchecked. See job #15.
  if (plan.record_kind !== "existing_holding" && plan.order_state !== "none") {
    throw new HubError(409, "too_late", `Plan ${plan.id} already has an order recorded, so it can no longer be reviewed.`);
  }
  if (plan.review_state === "declined") throw new HubError(409, "declined", `Casey declined plan ${plan.id}.`);
  if (verdict === "objected" && !comment) throw new HubError(400, "bad_review", "An objection needs a comment saying what is wrong.");
  if (verdict === "reviewed" && plan.review_state === "authorized") {
    return { ...(await getPlan(env, actor, plan.id)), changed: false };
  }
  await env.DB.prepare(`UPDATE plans SET review_state = ?2, reviewed_by = ?3, review_comment = ?4, updated_at = ?5 WHERE id = ?1`)
    .bind(plan.id, verdict, actor.name, comment, now())
    .run();
  await planEvent(env, plan.id, actor, verdict === "reviewed" ? "reviewed the plan" : "objected to the plan", { comment });
  await systemMessage(
    env,
    verdict === "reviewed"
      ? `${actor.name} reviewed plan ${plan.id} (${plan.symbol}). It is ready for Casey to approve or decline.`
      : `${actor.name} objected to plan ${plan.id} (${plan.symbol}): ${comment}`,
  );
  await touchAgent(env, actor, `${verdict} plan ${plan.id}`);
  return { ...(await getPlan(env, actor, plan.id)), changed: true };
}

export async function decidePlan(env: Env, actor: Actor, id: unknown, approve: boolean) {
  ownerOnly(actor, "approve or decline a plan");
  const { plan } = await getPlan(env, actor, id);
  if (approve) {
    if (plan.review_state !== "reviewed") {
      throw new HubError(
        409,
        "not_reviewed",
        plan.review_state === "objected"
          ? `Plan ${plan.id} has an open objection. It can be approved once the objection is settled and it is reviewed again.`
          : `Plan ${plan.id} has not been reviewed by a second AI yet.`,
      );
    }
    await env.DB.prepare(`UPDATE plans SET review_state = 'authorized', updated_at = ?2 WHERE id = ?1`).bind(plan.id, now()).run();
    await planEvent(env, plan.id, actor, "approved the plan", { entry: plan.entry_price, stop: plan.stop_price, target: plan.target_price, size: plan.size_dollars });
    await systemMessage(env, `Casey approved plan ${plan.id} (${plan.symbol}) as written. The approval covers this version only. Any change to price, size or symbol needs a new review and approval.`);
  } else {
    if (plan.order_state !== "none" && plan.order_state !== "closed") {
      throw new HubError(409, "order_exists", `Plan ${plan.id} already has an order recorded. Declining it here would not cancel that order. Cancel it in the Robinhood app.`);
    }
    await env.DB.prepare(`UPDATE plans SET review_state = 'declined', updated_at = ?2 WHERE id = ?1`).bind(plan.id, now()).run();
    await planEvent(env, plan.id, actor, "declined the plan");
    await systemMessage(env, `Casey declined plan ${plan.id} (${plan.symbol}). It stays in the log.`);
  }
  return getPlan(env, actor, plan.id);
}

// --------------------------------------------------------------- decisions

export interface DecisionRow {
  id: number;
  created_at: number;
  author_kind: string;
  author_id: string;
  author_name: string;
  question: string;
  context: string | null;
  options: string | null;
  status: string;
  answer: string | null;
  answered_at: number | null;
}

function decisionOut(d: DecisionRow) {
  const { idem_key: _internal, ...rest } = d as DecisionRow & { idem_key?: string };
  return { ...rest, options: d.options ? (JSON.parse(d.options) as string[]) : [] };
}

export async function proposeDecision(env: Env, actor: Actor, input: Record<string, unknown>) {
  requireScope(actor, "hub:log");
  const question = textOrNull(input.question, 500);
  if (!question) throw new HubError(400, "bad_decision", "A decision needs a question for Casey, in one plain sentence.");
  let options: string[] = [];
  if (input.options !== undefined && input.options !== null) {
    if (!Array.isArray(input.options)) throw new HubError(400, "bad_decision", "options must be a list of short answers.");
    options = input.options.map((o) => String(o).trim().slice(0, 120)).filter(Boolean).slice(0, 6);
  }
  const idem = textOrNull(input.idempotency_key, 200);
  const key = idem ? `${actor.id}:${idem}` : null;
  if (key) {
    const existing = await env.DB.prepare(`SELECT * FROM decisions WHERE idem_key = ?1`).bind(key).first<DecisionRow>();
    if (existing) return decisionOut(existing);
  }
  const res = await env.DB.prepare(
    `INSERT INTO decisions (created_at, author_kind, author_id, author_name, question, context, options, idem_key)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  )
    .bind(now(), actor.kind, actor.id, actor.name, question, textOrNull(input.context, 3000), JSON.stringify(options), key)
    .run();
  await touchAgent(env, actor, "asked Casey a question");
  const row = await env.DB.prepare(`SELECT * FROM decisions WHERE id = ?1`).bind(Number(res.meta.last_row_id)).first<DecisionRow>();
  return decisionOut(row!);
}

export async function listDecisions(env: Env, actor: Actor, opts: { status?: unknown; limit?: unknown } = {}) {
  requireScope(actor, "hub:read");
  const status = String(opts.status ?? "open");
  const limit = clampInt(opts.limit, 30, 1, 100);
  const sql =
    status === "all"
      ? `SELECT * FROM decisions ORDER BY id DESC LIMIT ?1`
      : `SELECT * FROM decisions WHERE status = ?2 ORDER BY id DESC LIMIT ?1`;
  const stmt = status === "all" ? env.DB.prepare(sql).bind(limit) : env.DB.prepare(sql).bind(limit, status);
  const { results } = await stmt.all<DecisionRow>();
  return results.map(decisionOut);
}

export async function answerDecision(env: Env, actor: Actor, id: unknown, answerIn: unknown) {
  ownerOnly(actor, "answer a decision");
  const answer = textOrNull(answerIn, 2000);
  if (!answer) throw new HubError(400, "bad_decision", "The answer is empty.");
  const row = await env.DB.prepare(`SELECT * FROM decisions WHERE id = ?1`).bind(Number(id)).first<DecisionRow>();
  if (!row) throw new HubError(404, "no_such_decision", "That question no longer exists.");
  if (row.status !== "open") throw new HubError(409, "already_settled", "That question has already been settled.");
  await env.DB.prepare(`UPDATE decisions SET status = 'answered', answer = ?2, answered_at = ?3 WHERE id = ?1`)
    .bind(row.id, answer, now())
    .run();
  await systemMessage(env, `Casey answered a question from ${row.author_name}.\n\n**Question:** ${row.question}\n\n**Answer:** ${answer}`);
  return decisionOut({ ...row, status: "answered", answer, answered_at: now() });
}

export async function withdrawDecision(env: Env, actor: Actor, id: unknown) {
  requireScope(actor, "hub:log");
  const row = await env.DB.prepare(`SELECT * FROM decisions WHERE id = ?1`).bind(Number(id)).first<DecisionRow>();
  if (!row) throw new HubError(404, "no_such_decision", "That question no longer exists.");
  if (actor.kind !== "owner" && row.author_id !== actor.id) throw new HubError(403, "not_author", "Only the one who asked a question, or Casey, can withdraw it.");
  if (row.status !== "open") throw new HubError(409, "already_settled", "That question has already been settled.");
  await env.DB.prepare(`UPDATE decisions SET status = 'withdrawn', answered_at = ?2 WHERE id = ?1`).bind(row.id, now()).run();
  return decisionOut({ ...row, status: "withdrawn" });
}

// ------------------------------------------------------------------ export

export async function exportAll(env: Env, actor: Actor) {
  ownerOnly(actor, "export the hub's records");
  const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
  return {
    exported_at: new Date().toISOString(),
    note: "Driftline Trading Hub export. Contains no passwords, sign-in tokens or broker credentials.",
    tasks: await all(`SELECT * FROM tasks ORDER BY id`),
    task_events: await all(`SELECT * FROM task_events ORDER BY id`),
    rules: await all(`SELECT * FROM rules ORDER BY version`),
    messages: await all(`SELECT id, author_kind, author_id, author_name, body, created_at FROM messages ORDER BY id`),
    plans: await all(`SELECT * FROM plans ORDER BY created_at`),
    plan_events: await all(`SELECT * FROM plan_events ORDER BY id`),
    decisions: await all(`SELECT id, created_at, author_kind, author_id, author_name, question, context, options, status, answer, answered_at FROM decisions ORDER BY id`),
    snapshots: await all(`SELECT id, author_id, author_name, source, observed_at, uploaded_at, completeness, total_value, cash, buying_power, day_change, positions, open_orders, note FROM snapshots ORDER BY id`),
  };
}
