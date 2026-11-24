// A holding Casey already owns is a record of something he has, not a proposal.
// "Approve this plan" on one would be an authorization attached to no order, on
// the board looking like permission to buy. ChatGPT caught that the card still
// offered it after the rest of the change had stopped treating holdings as
// approvable. Exercising the real planHtml rather than reading the source, so
// this keeps holding when the card is rewritten. See hub job #15.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('  function planHtml('), source.indexOf('  function renderTrades()'));
assert.ok(fn.includes('data-plan-kind'), 'planHtml was not extracted; check the slice boundaries');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const planHtml = new Function(
  'esc', 'ago', 'price', 'money', 'shortDate', 'orderWords', 'clock', 'openHistories', 'historyCache',
  `${fn}; return planHtml;`,
)(esc, () => 'a moment ago', (v) => v ?? '—', (v) => (v == null ? null : `$${v}`), (v) => v ?? '—',
  () => 'No order', () => 'now', new Set(), {});

const plan = (over = {}, ctx) => planHtml({
  id: '2026-11-23-1', symbol: 'TSTA', author_name: 'Grok', what_we_see: 'Something',
  review_state: 'reviewed', order_state: 'none', record_kind: 'trade_plan',
  created_at: 0, reviewed_by: 'Claude', ...over,
}, ctx);

test('a reviewed trade plan still offers approval', () => {
  const html = plan();
  assert.match(html, /data-plan-act="approve"/);
  assert.match(html, /Approve this plan/);
});

test('a reviewed holding offers no approval, because there is no order to approve', () => {
  const html = plan({ record_kind: 'existing_holding' });
  assert.doesNotMatch(html, /data-plan-act="approve"/, 'checking a holding must never become a prompt to authorize a trade');
  assert.doesNotMatch(html, /Approve this plan/);
});

test('an approved holding cannot appear approved either', () => {
  // review_state authorized should not be reachable for a holding now that
  // decidePlan refuses it, but the card must not render the action regardless.
  assert.doesNotMatch(plan({ record_kind: 'existing_holding', review_state: 'authorized' }), /data-plan-act="approve"/);
});

test('both records offer exactly one kind control, and it points the other way', () => {
  assert.match(plan(), /data-plan-kind="existing_holding"/);
  assert.doesNotMatch(plan(), /data-plan-kind="trade_plan"/);
  assert.match(plan({ record_kind: 'existing_holding' }), /data-plan-kind="trade_plan"/);
  assert.doesNotMatch(plan({ record_kind: 'existing_holding' }), /data-plan-kind="existing_holding"/);
});

test('the kind control is armed twice before it fires, like approve and decline', () => {
  assert.match(source, /if \(t\.dataset\.planKind\)[\s\S]{0,400}if \(!t\.dataset\.armed\)/,
    'moving a red flag on or off the board must not happen on a single stray tap');
});


// Grok's two stop proposals sat on the page looking live days after their own
// good_until had passed and after Casey had sold the positions they protected.
// Both facts were already in the data. Nothing read them.
const MONDAY = Date.parse('2026-11-23T22:00:00Z');
const holding = (...syms) => ({ positions: syms.map((symbol) => ({ symbol })), observed_at: MONDAY });

test('a plan past its own good-until date says so', () => {
  const html = plan({ good_until: '2026-11-21', stop_price: 28 }, { now: MONDAY, snapshot: holding('TSTA') });
  assert.match(html, /data-plan-lapsed="true"/);
  assert.match(html, /Out of date/);
  assert.match(html, /good-until date passed/);
});

test('a plan is good through the whole of its last day', () => {
  // Expiring at midnight would retire a plan on the morning of the day it covers.
  const sameDay = plan({ good_until: '2026-11-23', stop_price: 28 }, { now: MONDAY, snapshot: holding('TSTA') });
  assert.doesNotMatch(sameDay, /data-plan-lapsed/);
  const nextDay = plan({ good_until: '2026-11-23', stop_price: 28 },
    { now: Date.parse('2026-11-24T00:30:00Z'), snapshot: holding('TSTA') });
  assert.match(nextDay, /data-plan-lapsed="true"/);
});

test('a stop plan for a position the account no longer holds says so', () => {
  const html = plan({ good_until: '2026-12-31', stop_price: 28 }, { now: MONDAY, snapshot: holding('SPY') });
  assert.match(html, /data-plan-lapsed="true"/);
  assert.match(html, /no TSTA position/);
});

test('a snapshot that reported no positions at all is not treated as an empty account', () => {
  // No positions array means nobody has reported, which is not the same as
  // reporting none. Guessing there would retire every plan on a quiet hub.
  const html = plan({ good_until: '2026-12-31', stop_price: 28 }, { now: MONDAY, snapshot: { observed_at: MONDAY } });
  assert.doesNotMatch(html, /data-plan-lapsed/);
  assert.doesNotMatch(plan({ good_until: '2026-12-31', stop_price: 28 }, { now: MONDAY }), /data-plan-lapsed/);
});

test('a plan with no stop or target is not called orphaned', () => {
  // An idea with no position attached has nothing to be orphaned from.
  const html = plan({ good_until: '2026-12-31' }, { now: MONDAY, snapshot: holding('SPY') });
  assert.doesNotMatch(html, /data-plan-lapsed/);
});

test('a closed or declined plan is left alone', () => {
  const past = { good_until: '2026-11-01', stop_price: 28 };
  const ctx = { now: MONDAY, snapshot: holding('SPY') };
  assert.doesNotMatch(plan({ ...past, order_state: 'closed' }, ctx), /data-plan-lapsed/);
  assert.doesNotMatch(plan({ ...past, review_state: 'declined' }, ctx), /data-plan-lapsed/);
});

test('both reasons are given when both are true', () => {
  const html = plan({ good_until: '2026-11-21', stop_price: 28 }, { now: MONDAY, snapshot: holding('SPY') });
  assert.match(html, /good-until date passed/);
  assert.match(html, /no TSTA position/);
});

test('a live plan carries no out-of-date wording at all', () => {
  const html = plan({ good_until: '2026-12-31', stop_price: 28 }, { now: MONDAY, snapshot: holding('TSTA') });
  assert.doesNotMatch(html, /Out of date/);
  assert.doesNotMatch(html, /data-plan-lapsed/);
});
