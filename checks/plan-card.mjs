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
const fn = source.slice(source.indexOf('  function planHtml(p)'), source.indexOf('  function renderTrades()'));
assert.ok(fn.includes('data-plan-kind'), 'planHtml was not extracted; check the slice boundaries');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const planHtml = new Function(
  'esc', 'ago', 'price', 'money', 'shortDate', 'orderWords', 'clock', 'openHistories', 'historyCache',
  `${fn}; return planHtml;`,
)(esc, () => 'a moment ago', (v) => v ?? '—', (v) => (v == null ? null : `$${v}`), (v) => v ?? '—',
  () => 'No order', () => 'now', new Set(), {});

const plan = (over = {}) => planHtml({
  id: '2026-11-23-1', symbol: 'TSTA', author_name: 'Grok', what_we_see: 'Something',
  review_state: 'reviewed', order_state: 'none', record_kind: 'trade_plan',
  created_at: 0, reviewed_by: 'Claude', ...over,
});

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
