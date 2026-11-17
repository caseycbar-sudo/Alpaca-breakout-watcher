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
