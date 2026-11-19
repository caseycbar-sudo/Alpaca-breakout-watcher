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
test('missing drawdown is explicit in both the visible row and accessible chart label', () => {
  for (const value of [null, undefined, NaN, Infinity]) {
    const html = render({research:research({strategies:[{name:'Missing drawdown',cagr:5,worst_drawdown:value,since:'2019-01-01'}]})});
    assert.match(html, /<span>worst fall not reported along the way/);
    assert.match(html, /aria-label="Missing drawdown: 5% a year, worst fall not reported"/);
    assert.doesNotMatch(html, /null%|undefined%|NaN%|Infinity%/);
  }
});
test('zero drawdown remains a reported zero in both visible and accessible output', () => {
  const html = render({research:research({strategies:[{name:'Zero drawdown',cagr:5,worst_drawdown:0,since:'2019-01-01'}]})});
  assert.match(html, /<span>worst fall 0% along the way/);
  assert.match(html, /aria-label="Zero drawdown: 5% a year, worst fall 0%"/);
});

// Job #12 content slice, agreed in hub #355/#356. The Overview leads with what needs
// Casey, built from the board's one canonical exception list, with the historical
// records still behind the disclosure and never merged into the current ones.
test('needs-you material leads the Overview, above the ticker', () => {
  const html = render({ need: { total: 1, questions: [{}], approvals: [] },
    board: board({ exceptions: [{ level: 'warn', text: 'A current flag' }] }) });
  const alert = html.indexOf('waiting on you');
  const question = html.indexOf('Pending question');
  const flags = html.indexOf('id="v2-flaglist"');
  assert.ok(alert > -1 && question > alert, 'the question card follows its own headline');
  assert.ok(flags > question, 'the flag list follows the decision that needs answering');
});

test('current and historical warnings stay separate even for the same symbol', () => {
  const html = render({ board: board({
    exceptions: [{ level: 'warn', text: 'QQQ: current protection unknown.' }],
    historical_details: [{ text: 'QQQ had no stop in the snapshot reported by Grok on Nov 17.' }] }) });
  // Both survive. Deduplicating by symbol would drop the dated source record, which is
  // the only place the reporter and date appear.
  assert.match(html, /QQQ: current protection unknown/);
  assert.match(html, /QQQ had no stop in the snapshot reported by Grok on Nov 17/);
  assert.match(html, /What the earlier reports actually said/);
});

// Casey found this one. A second handler for data-expand was added earlier in the
// click chain for job cards; it returned unconditionally, so chat's "Show the whole
// message" button stopped working and silently did nothing on every tap. Jobs use a
// native <details> now and do not need the attribute at all.
test('only one handler claims data-expand, so chat keeps its expand button', () => {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const handlers = appJs.match(/if \(t\.dataset\.expand\)/g) || [];
  assert.equal(handlers.length, 1,
    'a second data-expand branch will swallow chat clicks before chat sees them');
  // And the one that remains must be the chat one, which records the id and re-renders.
  assert.match(appJs, /if \(t\.dataset\.expand\) \{\s*expandedMessages\.add/);
  // The button targets the message id; messages carry data-id, never id, so a
  // getElementById lookup on it would always miss.
  assert.match(appJs, /data-expand="\$\{m\.id\}"/);
  assert.doesNotMatch(appJs, /getElementById\(t\.dataset\.expand\)/);
});
