// Exercise the actual frontend render functions with synthetic state, without a live account.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('  function renderToday()'), source.indexOf('  function messageHtml('));
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
export function render(overrides = {}) {
  const state = {
    board: { exceptions: [], historical_details: [], historical_notices: [], snapshot: null,
      rules: { version: 1, max_positions: 2, slots_left: 2, max_per_trade: 40, daily_trigger: 20, instruments: 'Stocks and ETFs' } },
    research: null, ...overrides,
  };
  const need = overrides.need || { total: 0, questions: [], approvals: [] };
  return new Function('S','needsYou','esc','count','money','ticker','coverageTag','slipFor','approvalSlip','sinceWords','driftline',
    `${functions}; return renderToday();`)(state, () => need, escape, (n,s,p) => `${n} ${n === 1 ? s : p}`, n => `$${n}`,
    () => '', () => '', () => '<p>Pending question</p>', () => '<p>Pending approval</p>', n => `${n} seconds ago`, () => '');
}
const board = (extra = {}) => ({ exceptions: [], snapshot: null, rules: { max_positions: 2, slots_left: 2 }, ...extra });
const research = (extra = {}) => ({ read_at: Date.now(), swing: { strategies: [{ name: 'Synthetic strategy', cagr: 2, worst_drawdown: -8, since: '2019-01-01' }], ...extra } });
test('historical-only records have a native disclosure, including escaped source caveats', () => {
  const html = render({ board: board({ historical_notices: [{text: '<earlier> account match unverified'}] }) });
  assert.match(html, /<details[^>]*id="v2-flaglist"><summary>Show earlier protection reports/);
  assert.match(html, /&#60;earlier&#62; account match unverified/);
  assert.doesNotMatch(html, /id="v2-flaglist" hidden/);
});
test('stop alert keeps all flags and historical reports accessible', () => {
  const html = render({ board: board({ exceptions: [{level:'stop', text:'Stop'}, {level:'warn',text:'Second flag'}], historical_details:[{text:'Historical source'}] }) });
  assert.match(html, /Stop and look/); assert.match(html, /<summary>Show all 2 flags and earlier reports/);
  assert.match(html, /Second flag/); assert.match(html, /Historical source/);
});
test('pending questions and approvals never receive the all-clear headline', () => {
  for (const need of [{total:1,questions:[{}],approvals:[]},{total:1,questions:[],approvals:[{}]}]) {
    const html = render({need}); assert.match(html, /waiting on you/); assert.doesNotMatch(html, /Nothing needs you/);
  }
});
test('partial lab failures remain visible alongside results', () => {
  assert.match(render({research:research({problem:'Signal fetch failed'})}), /Signal fetch failed/);
});
test('old and unknown signals retain observation dates without claiming today or cash', () => {
  const html = render({research:research({signals:{sleeves:[{symbol:'ABC',signal:'HOLD',as_of:'2026-01-01'},{symbol:'DEF',signal:null,as_of:null}]}})});
  assert.match(html, /ABC reads hold; as of 2026-01-01/); assert.match(html, /DEF reads unknown; as of unknown date/);
  assert.doesNotMatch(html, /stands today|DEF reads cash/); assert.match(html, /swing_lab.json/);
});
test('unavailable, empty and unread labs give an explicit state', () => {
  assert.match(render(), /Lab results have not been read yet/);
  assert.match(render({research:research({strategies:[]})}), /No readable strategy results/);
  assert.match(render({research:{unavailable:'Cannot fetch lab'}}), /Cannot fetch lab/);
});
test('one strategy is shown once and non-finite results never become chart coordinates', () => {
  const html = render({research:research()}); assert.equal((html.match(/<b>Synthetic strategy<\/b>/g)||[]).length,1);
  assert.doesNotMatch(render({research:research({strategies:[{name:'broken',cagr:Infinity}]})}), /NaN|Infinity/);
});
test('daily trigger retains the non-continuous monitoring caveat', () => {
  assert.match(render(), /not watched continuously/); assert.match(render(), /does not cap a day/);
});
