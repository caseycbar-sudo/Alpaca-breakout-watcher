// The hub's own rules, tested directly against the database layer.
import { env as rawEnv } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as db from "../src/db";
import type { Actor, Env } from "../src/util";

const env = rawEnv as unknown as Env;
const casey: Actor = { kind: "owner", id: "casey", name: "Casey", scopes: [] };
const ALL = ["hub:read", "hub:chat", "hub:log", "hub:snapshot"];
const grok: Actor = { kind: "agent", id: "grok", name: "Grok", scopes: ALL };
const claude: Actor = { kind: "agent", id: "claude", name: "Claude", scopes: ALL };
const reader: Actor = { kind: "agent", id: "chatgpt", name: "ChatGPT", scopes: ["hub:read"] };

const rejects = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toMatchObject({ code });
};

describe("stop coverage", () => {
  const pos = { symbol: "QQQ", quantity: 1, average_cost: null, market_value: null };
  const stop = (quantity: number, symbol = "QQQ") => ({ symbol, side: "sell" as const, type: "stop", quantity, limit_price: null, stop_price: 400, status: null, broker_order_id: null });
  it("is unknown when open orders were not reported", () => expect(db.coverageFor(pos, null).coverage).toBe("unknown"));
  it("is none when orders were checked and there is no stop", () => expect(db.coverageFor(pos, []).coverage).toBe("none"));
  it("is partial when the stop covers less than the holding", () => expect(db.coverageFor(pos, [stop(0.4)]).coverage).toBe("partial"));
  it("is confirmed when stops cover the whole holding", () => expect(db.coverageFor(pos, [stop(0.6), stop(0.4)]).coverage).toBe("confirmed"));
  it("ignores stops on other symbols and plain limit sells", () => {
    expect(db.coverageFor(pos, [stop(5, "PSQ"), { ...stop(1), type: "limit" }]).coverage).toBe("none");
  });
});

describe("chat", () => {
  it("keeps order, counts unread per reader, and never posts a retry twice", async () => {
    const a = await db.postMessage(env, casey, "hello agents");
    const b = await db.postMessage(env, grok, "Grok here", "k1");
    const again = await db.postMessage(env, grok, "Grok here", "k1");
    expect(again.id).toBe(b.id);
    expect(b.id).toBeGreaterThan(a.id);

    expect(await db.unreadCount(env, "claude")).toBe(2);
    expect(await db.unreadCount(env, "grok")).toBe(0); // its own post, and posting marks earlier ones seen
    const page = await db.readChat(env, claude, {});
    expect(page.messages.map((m) => m.body)).toEqual(["hello agents", "Grok here"]);
    expect(page.unread_before_this_read).toBe(2);
    expect(await db.unreadCount(env, "claude")).toBe(0);
  });

  it("pages in both directions without skipping or repeating", async () => {
    for (let i = 1; i <= 7; i++) await db.postMessage(env, casey, `m${i}`);
    const newest = await db.readChat(env, claude, { limit: 3 });
    expect(newest.messages.map((m) => m.body)).toEqual(["m5", "m6", "m7"]);
    expect(newest.has_older).toBe(true);
    const older = await db.readChat(env, claude, { before_id: newest.oldest_id, limit: 3 });
    expect(older.messages.map((m) => m.body)).toEqual(["m2", "m3", "m4"]);
    const forward = await db.readChat(env, claude, { after_id: older.newest_id, limit: 2 });
    expect(forward.messages.map((m) => m.body)).toEqual(["m5", "m6"]);
    expect(forward.has_newer).toBe(true);
  });

  it("refuses an AI that was not given the chat permission", async () => {
    await rejects(db.postMessage(env, reader, "hi"), "not_permitted");
  });
});

describe("the board", () => {
  it("says so plainly when nothing has been reported", async () => {
    const board = await db.buildBoard(env);
    expect(board.snapshot).toBeNull();
    expect(board.connections.engine).toBe("none");
    expect(board.exceptions[0].text).toMatch(/No account snapshot/);
  });

  it("flags missing stops, borrowed buying power, and the daily stop", async () => {
    await db.postSnapshot(env, grok, {
      source: "Robinhood agent connection", total_value: 208, cash: 162, buying_power: 300, day_change: -25,
      positions: [{ symbol: "QQQ", quantity: 0.026 }, { symbol: "PSQ", quantity: 1 }],
      open_orders: [{ symbol: "PSQ", side: "sell", type: "stop", quantity: 1, stop_price: 30 }],
    });
    const board = await db.buildBoard(env);
    const texts = board.exceptions.map((e) => e.text).join(" | ");
    expect(texts).toMatch(/QQQ has no stop/);
    expect(texts).not.toMatch(/PSQ has no stop/);
    expect(texts).toMatch(/Buying power is higher than cash/);
    expect(texts).toMatch(/daily stop/);
    expect((board.snapshot as any).positions.find((p: any) => p.symbol === "PSQ").coverage).toBe("confirmed");
    expect(board.rules.slots_left).toBe(0);
  });

  it("marks old numbers as out of date instead of showing them as current", async () => {
    await db.postSnapshot(env, grok, { source: "test", cash: 100, positions: [], open_orders: [] });
    const later = Date.now() + (db.STALE_AFTER_MINUTES + 5) * 60_000;
    const board = await db.buildBoard(env, later);
    expect((board.snapshot as any).stale).toBe(true);
    expect(board.exceptions.some((e) => /out of date/.test(e.text))).toBe(true);
  });

  it("keeps 'not reported' different from zero", async () => {
    await db.postSnapshot(env, grok, { source: "test", total_value: 200 });
    const board = await db.buildBoard(env);
    const snap = board.snapshot as any;
    expect(snap.cash).toBeNull();
    expect(snap.positions).toBeNull();
    expect(snap.completeness).toBe("partial");
  });

  it("refuses a snapshot from an AI without that permission, and one with no source", async () => {
    await rejects(db.postSnapshot(env, reader, { source: "x" }), "not_permitted");
    await rejects(db.postSnapshot(env, grok, {}), "bad_snapshot");
  });
});

describe("trade plans", () => {
  const idea = { symbol: "spy", what_we_see: "Pullback to support", entry_price: 500, target_price: 510, stop_price: 495, size_dollars: 40 };

  it("refuses a plan bigger than the per-trade limit", async () => {
    await rejects(db.savePlan(env, grok, { ...idea, size_dollars: 41 }), "over_limit");
  });

  it("needs a second AI to review, then Casey to approve", async () => {
    const { plan } = await db.savePlan(env, grok, idea);
    expect(plan.symbol).toBe("SPY");
    expect(plan.review_state).toBe("draft");

    await rejects(db.reviewPlan(env, grok, { id: plan.id, verdict: "reviewed" }), "own_plan");
    await rejects(db.decidePlan(env, casey, plan.id, true), "not_reviewed");
    await rejects(db.decidePlan(env, claude, plan.id, true), "owner_only");

    await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed", comment: "Sizes check out" });
    const approved = await db.decidePlan(env, casey, plan.id, true);
    expect(approved.plan.review_state).toBe("authorized");
    expect(approved.history.map((h: any) => h.action)).toEqual(["created the plan", "reviewed the plan", "approved the plan"]);
  });

  it("clears the review and approval when the price, size or symbol changes", async () => {
    const { plan } = await db.savePlan(env, grok, idea);
    await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed" });
    await db.decidePlan(env, casey, plan.id, true);
    const changed = await db.savePlan(env, grok, { id: plan.id, entry_price: 499 });
    expect(changed.review_reset).toBe(true);
    expect(changed.plan.review_state).toBe("draft");
    // A note that is not price, size or symbol does not undo an approval.
    await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed" });
    await db.decidePlan(env, casey, plan.id, true);
    const noted = await db.savePlan(env, grok, { id: plan.id, sources: "chart" });
    expect(noted.plan.review_state).toBe("authorized");
  });

  it("lets only the author change the idea, and nobody set the review state directly", async () => {
    const { plan } = await db.savePlan(env, grok, idea);
    await rejects(db.savePlan(env, claude, { id: plan.id, stop_price: 400 }), "not_author");
    await rejects(db.savePlan(env, grok, { id: plan.id, review_state: "authorized" }), "bad_plan");
    await rejects(db.savePlan(env, reader, idea), "not_permitted");
  });

  it("requires a reason to object, and an objection blocks approval", async () => {
    const { plan } = await db.savePlan(env, grok, idea);
    await rejects(db.reviewPlan(env, claude, { id: plan.id, verdict: "objected" }), "bad_review");
    await db.reviewPlan(env, claude, { id: plan.id, verdict: "objected", comment: "Stop is too tight" });
    await rejects(db.decidePlan(env, casey, plan.id, true), "not_reviewed");
  });

  it("flags an order recorded on a plan Casey never approved", async () => {
    const { plan } = await db.savePlan(env, grok, idea);
    await db.savePlan(env, grok, { id: plan.id, order_state: "working" });
    const board = await db.buildBoard(env);
    expect(board.exceptions.some((e) => e.level === "stop" && e.text.includes(plan.id))).toBe(true);
  });
});

// Casey's QQQ and PSQ were bought in Robinhood before this hub existed. Recorded
// as trade plans they raised a red "Casey has not approved" on the board, could
// not be reviewed at all, and carried an average cost in fill_price. Job #15.
describe("holdings Casey already owned", () => {
  const qqq = {
    symbol: "QQQ", record_kind: "existing_holding",
    what_we_see: "Already owned in Robinhood, bought before the hub existed.",
    quantity: 0.025793, average_cost: 756.02,
    observed_at: 1795000000000, observed_source: "snapshot #27, Robinhood connection",
  };
  const psq = { ...qqq, symbol: "PSQ", quantity: 1, average_cost: 26.61 };

  it("keeps the average cost out of fill_price", async () => {
    const { plan } = await db.savePlan(env, grok, qqq);
    expect(plan.record_kind).toBe("existing_holding");
    expect(plan.average_cost).toBe(756.02);
    expect(plan.quantity).toBe(0.025793);
    expect(plan.fill_price).toBe(null);
    expect(plan.observed_source).toContain("snapshot #27");
    await rejects(db.savePlan(env, grok, { ...psq, fill_price: 26.61 }), "bad_plan");
  });

  it("does not call a holding Casey already owns an unapproved order", async () => {
    const { plan } = await db.savePlan(env, grok, psq);
    const board = await db.buildBoard(env);
    const mine = board.exceptions.filter((e) => e.text.includes(plan.id));
    expect(mine.filter((e) => e.level === "stop")).toEqual([]);
    expect(mine.some((e) => e.text.includes("has not approved"))).toBe(false);
  });

  it("still says out loud that the holding has no stop", async () => {
    await db.savePlan(env, grok, qqq);
    const board = await db.buildBoard(env);
    // The missing stop is the real risk and has to stay visible.
    expect(board.exceptions.some((e) => e.level === "warn" && e.text.includes("QQQ") && e.text.includes("stop"))).toBe(true);
    // Said once, however many records of QQQ exist and whoever noticed first.
    expect(board.exceptions.filter((e) => e.text.includes("QQQ") && e.text.includes("already owned")).length).toBeLessThanOrEqual(1);
  });

  it("stops warning once the stop on that holding is confirmed", async () => {
    const { plan } = await db.savePlan(env, grok, { ...qqq, symbol: "VOO" });
    expect((await db.buildBoard(env)).exceptions.some((e) => e.text.includes("VOO"))).toBe(true);
    const confirmed = await db.savePlan(env, grok, { id: plan.id, protection_state: "confirmed" });
    expect(confirmed.plan.protection_state).toBe("confirmed");
    expect((await db.buildBoard(env)).exceptions.some((e) => e.text.includes("VOO"))).toBe(false);
  });

  it("can be checked by another AI instead of answering too_late", async () => {
    const { plan } = await db.savePlan(env, grok, qqq);
    await db.savePlan(env, grok, { id: plan.id, order_state: "filled" });
    const checked = await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed", comment: "Matches snapshot #27" });
    expect(checked.plan.review_state).toBe("reviewed");
    expect(checked.plan.reviewed_by).toBe("Claude");
  });

  it("clears the stale fill price when a mis-filed record is reclassified", async () => {
    const { plan } = await db.savePlan(env, grok, { symbol: "PSQ", what_we_see: "Recorded as a plan by mistake" });
    await db.savePlan(env, grok, { id: plan.id, order_state: "filled", fill_price: 26.61 });
    const fixed = await db.savePlan(env, casey, { id: plan.id, record_kind: "existing_holding", average_cost: 26.61, quantity: 1 });
    expect(fixed.plan.record_kind).toBe("existing_holding");
    expect(fixed.plan.fill_price).toBe(null);
    expect(fixed.plan.average_cost).toBe(26.61);
    const board = await db.buildBoard(env);
    expect(board.exceptions.some((e) => e.level === "stop" && e.text.includes(plan.id))).toBe(false);
    // Taking a red flag off the board is announced, never silent.
    const { messages } = await db.readChat(env, claude, { limit: 5 });
    expect(messages.some((m: any) => m.body.includes(plan.id) && m.body.includes("already owned"))).toBe(true);
  });

  it("refuses a record kind it does not know", async () => {
    await rejects(db.savePlan(env, grok, { ...qqq, record_kind: "whatever" }), "bad_plan");
  });
});

// An announcement records a change; it does not prevent one. ChatGPT's review of
// PR #30 caught that any AI could clear the "Casey has not approved this order"
// stop simply by relabelling the order as something he already owned. Changing
// the kind of a record that exists is Casey's, in both directions. Job #15.
describe("who may change what kind of record something is", () => {
  const holding = {
    symbol: "TSTA", record_kind: "existing_holding",
    what_we_see: "Already owned, bought outside the hub.",
    quantity: 3, average_cost: 11.5, observed_at: 1795000000000, observed_source: "snapshot #27",
  };

  it("lets any AI record a new holding, which silences nothing", async () => {
    const { plan } = await db.savePlan(env, grok, holding);
    expect(plan.record_kind).toBe("existing_holding");
  });

  it("refuses an AI turning someone else's order into a holding", async () => {
    const { plan } = await db.savePlan(env, grok, { symbol: "TSTD", what_we_see: "A real order" });
    await db.savePlan(env, grok, { id: plan.id, order_state: "working" });
    await rejects(db.savePlan(env, claude, { id: plan.id, record_kind: "existing_holding" }), "owner_only");
  });

  it("refuses the author doing it to their own order, which was the easy way round", async () => {
    const { plan } = await db.savePlan(env, grok, { symbol: "TSTD", what_we_see: "A real order" });
    await db.savePlan(env, grok, { id: plan.id, order_state: "filled" });
    await rejects(db.savePlan(env, grok, { id: plan.id, record_kind: "existing_holding" }), "owner_only");
  });

  it("keeps a refused order flagged on the board afterwards", async () => {
    const { plan } = await db.savePlan(env, grok, { symbol: "TSTE", what_we_see: "An order nobody approved" });
    await db.savePlan(env, grok, { id: plan.id, order_state: "working" });
    await rejects(db.savePlan(env, grok, { id: plan.id, record_kind: "existing_holding" }), "owner_only");
    const board = await db.buildBoard(env);
    const flag = board.exceptions.find((e) => e.text.includes(plan.id));
    expect(flag?.level).toBe("stop");
    expect(flag?.text).toContain("has not approved");
    const { plan: after } = await db.getPlan(env, claude, plan.id);
    expect(after.record_kind).toBe("trade_plan");
  });

  it("lets Casey do it, and sends the record back for a fresh review", async () => {
    const { plan } = await db.savePlan(env, grok, { symbol: "TSTF", what_we_see: "Mis-filed as a plan" });
    await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed", comment: "Checked as a trade plan" });
    await db.decidePlan(env, casey, plan.id, true);
    const converted = await db.savePlan(env, casey, { id: plan.id, record_kind: "existing_holding", quantity: 1, average_cost: 10 });
    expect(converted.plan.record_kind).toBe("existing_holding");
    expect(converted.review_reset).toBe(true);
    expect(converted.plan.review_state).toBe("draft");
    expect(converted.plan.reviewed_by).toBe(null);
  });

  it("does not let a holding's review become approval to buy", async () => {
    const { plan } = await db.savePlan(env, grok, { ...holding, symbol: "TSTG" });
    await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed", comment: "Matches the snapshot" });
    const back = await db.savePlan(env, casey, { id: plan.id, record_kind: "trade_plan" });
    expect(back.plan.record_kind).toBe("trade_plan");
    expect(back.plan.review_state).toBe("draft");
    expect(back.plan.reviewed_by).toBe(null);
  });

  it("sends a checked holding back for review when the broker numbers change", async () => {
    for (const field of [{ quantity: 4 }, { average_cost: 12.25 }, { observed_source: "snapshot #31" }, { observed_at: 1795400000000 }]) {
      const { plan } = await db.savePlan(env, grok, { ...holding, symbol: "TSTH" });
      await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed", comment: "Matches the snapshot" });
      const changed = await db.savePlan(env, grok, { id: plan.id, ...field });
      expect(changed.review_reset, Object.keys(field)[0]).toBe(true);
      expect(changed.plan.review_state, Object.keys(field)[0]).toBe("draft");
    }
  });

  it("refuses to let Casey approve a holding, because there is no order to approve", async () => {
    const { plan } = await db.savePlan(env, grok, { ...holding, symbol: "TSTJ" });
    await db.reviewPlan(env, claude, { id: plan.id, verdict: "reviewed", comment: "Matches the snapshot" });
    // Reviewed by a second AI, which for a trade plan is exactly the state that
    // makes approval available. A holding must not inherit that.
    const { plan: checked } = await db.getPlan(env, claude, plan.id);
    expect(checked.review_state).toBe("reviewed");
    await rejects(db.decidePlan(env, casey, plan.id, true), "nothing_to_approve");
    const { plan: after } = await db.getPlan(env, claude, plan.id);
    expect(after.review_state).toBe("reviewed");
  });

  it("still lets an AI update a holding's facts without owner permission", async () => {
    const { plan } = await db.savePlan(env, grok, { ...holding, symbol: "TSTI" });
    const updated = await db.savePlan(env, claude, { id: plan.id, quantity: 5, observed_source: "snapshot #31" });
    expect(updated.plan.quantity).toBe(5);
    expect(updated.plan.record_kind).toBe("existing_holding");
  });
});

describe("rules and questions", () => {
  it("starts with the limits Casey approved", async () => {
    const rules = await db.currentRules(env);
    expect([rules.version, rules.max_per_trade, rules.daily_trigger, rules.max_positions]).toEqual([1, 40, 20, 2]);
  });

  it("lets only Casey change the rules, as a new version with a reason", async () => {
    const change = { max_per_trade: 20, daily_trigger: 10, max_positions: 3, instruments: "Stocks and ETFs only", change_note: "Matching the watcher" };
    await rejects(db.newRulesVersion(env, grok, change), "owner_only");
    await rejects(db.newRulesVersion(env, casey, { ...change, change_note: "" }), "bad_rule");
    const next = await db.newRulesVersion(env, casey, change);
    expect(next.version).toBe(2);
    expect((await db.rulesHistory(env)).map((r) => r.version)).toEqual([2, 1]);
    await rejects(db.savePlan(env, grok, { symbol: "SPY", what_we_see: "x", size_dollars: 30 }), "over_limit");
  });

  it("puts questions on Casey's list, and only Casey can answer", async () => {
    const q = await db.proposeDecision(env, claude, { question: "Stocks, crypto, or both?", options: ["Stocks", "Crypto", "Both"] });
    expect(q.options).toEqual(["Stocks", "Crypto", "Both"]);
    await rejects(db.answerDecision(env, grok, q.id, "Both"), "owner_only");
    await rejects(db.proposeDecision(env, reader, { question: "?" }), "not_permitted");
    const answered = await db.answerDecision(env, casey, q.id, "Both");
    expect(answered.status).toBe("answered");
    await rejects(db.answerDecision(env, casey, q.id, "Stocks"), "already_settled");
    expect(await db.listDecisions(env, claude, { status: "open" })).toHaveLength(0);
  });
});
