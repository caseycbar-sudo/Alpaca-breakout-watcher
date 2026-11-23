// Exercise the actual frontend render functions with synthetic state, without a live account.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('  function newsRow('), source.indexOf('  function messageHtml('));
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const zoned = value => {
  if (typeof value !== 'string' || !/(?:[zZ]|[+-]\d\d:\d\d)$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export function render(overrides = {}) {
  const state = {
    board: { exceptions: [], historical_details: [], historical_notices: [], snapshot: null,
      rules: { version: 1, max_positions: 2, slots_left: 2, max_per_trade: 40, daily_trigger: 20, instruments: 'Stocks and ETFs' } },
    research: null, ...overrides,
  };
  const need = overrides.need || { total: 0, questions: [], approvals: [] };
  return new Function('S','needsYou','esc','count','money','ticker','coverageTag','slipFor','approvalSlip','sinceWords','driftline','zonedMs',
    `${functions}; return renderToday();`)(state, () => need, escape, (n,s,p) => `${n} ${n === 1 ? s : p}`, n => `$${n}`,
    () => '', () => '', () => '<p>Pending question</p>', () => '<p>Pending approval</p>', n => `${n} seconds ago`, () => '', zoned);
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
    assert.match(html, /class="ft">worst fall not reported along the way/);
    assert.match(html, /aria-label="Missing drawdown: 5% a year, worst fall not reported"/);
    assert.doesNotMatch(html, /null%|undefined%|NaN%|Infinity%/);
  }
});
test('zero drawdown remains a reported zero in both visible and accessible output', () => {
  const html = render({research:research({strategies:[{name:'Zero drawdown',cagr:5,worst_drawdown:0,since:'2019-01-01'}]})});
  assert.match(html, /class="ft">worst fall 0% along the way/);
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

test('the stale-draft discard button still has its own click handler', () => {
  const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /if \(t\.dataset\.discardJobDraft\)/,
    'the rendered discard button must not become a no-op when nearby handlers change');
  assert.match(appJs, /jobDrafts\.delete\(jobFormKey\(form\)\);[\s\S]*persistJobDrafts\(\);/,
    'discard must remove and persist the saved draft before re-rendering');
});

test('workspace radar distinguishes missing, closed, stale and timestamped zero-result scans', () => {
  const now = Date.parse('2026-11-23T16:00:00Z');
  const radar = { generated_at: '2026-11-23T15:58:00Z', candidate_count: 0, market: { is_open: true } };
  assert.match(render({server_time:now}), /data-scan-state="missing"/);
  const fresh = render({server_time:now,radar});
  assert.match(fresh, /No names qualified/);
  // Was /Scan 2 min ago/, the header's render-time age. That age is gone: it
  // froze while the clock beside it counted on. The live element carries it now.
  assert.match(fresh, /Last scan 2 min ago/);
  assert.match(fresh, /data-scan-state="reported"/);
  assert.match(render({server_time:now,radar:{...radar,market:{is_open:false}}}), /Market closed at last scan/);
  assert.match(render({server_time:now,radar:{...radar,generated_at:'2026-11-23T14:00:00Z'}}), /data-scan-state="late"/);
  const future = render({server_time:now,radar:{...radar,generated_at:'2026-11-24T15:58:00Z'}});
  assert.match(future, /Scan time unavailable/);
  assert.match(future, /data-scan-state="late"/);
});

test('activity preview uses actual API message fields, escapes content and excludes system notices', () => {
  const html = render({server_time:1000000,chat:{messages:[
    {author_kind:'system',author_name:'Hub',body:'internal wake notice',created_at:999999},
    {author_kind:'agent',author_name:'Claude',body:'<img src=x onerror=alert(1)>',created_at:940000},
  ]}});
  assert.doesNotMatch(html, /internal wake notice|<img/);
  assert.match(html, /&#60;img/);
  assert.match(html, /Claude/);
  assert.match(html, /1 min ago/);
  assert.match(html, /Read full message/);
});

test('news distinguishes unavailable, stale, empty and fresh states without sentiment labels', () => {
  const now = Date.parse('2026-11-23T16:00:00Z');
  assert.match(render({server_time:now}), /data-news-state="unavailable"/);
  assert.match(render({server_time:now,news:{stale:true,age_minutes:18,items:[]}}), /data-news-state="stale"/);
  assert.match(render({server_time:now,news:{stale:false,age_minutes:1,items:[]}}), /data-news-state="empty"/);
  const fresh = render({server_time:now,news:{stale:false,age_minutes:1,items:[{
    headline:'Company files 8-K', source:'Alpaca News', url:'https://example.com/item', symbols:['ABC'],
    published_at:'2026-11-23T15:58:00Z', first_seen_at:'2026-11-23T15:59:00Z',
  }]}});
  assert.match(fresh, /data-news-state="fresh"/);
  assert.match(fresh, /Company files 8-K/);
  assert.match(fresh, /without a bullish or bearish label/);
  assert.doesNotMatch(fresh, /BUY|SELL|positive catalyst/i);
});

test('news content is escaped and links are isolated from the Hub tab', () => {
  const html = render({server_time:Date.parse('2026-11-23T16:00:00Z'),news:{stale:false,items:[{
    headline:'<img src=x onerror=alert(1)>', source:'<wire>', url:'https://example.com/?q=&quot;', symbols:['ABC'],
    published_at:'2026-11-23T15:58:00Z', first_seen_at:'2026-11-23T15:59:00Z',
  }]}});
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&#60;img/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

// Casey asked for moving parts. The clock is the only thing that can honestly
// move between scans, so it is the only thing that does. These pin both halves:
// that it ticks, and that it never implies a price is ticking with it.
const appJsSource = source;
const clockSrc = appJsSource.slice(
  appJsSource.indexOf('  const SCAN_EVERY_MS'),
  appJsSource.indexOf('  // A view of reported work'),
);
const { scanClock, countdownWords, elapsedWords } = new Function(
  `${clockSrc}; return { scanClock, countdownWords, elapsedWords };`,
)();

const T0 = Date.parse('2026-11-23T16:00:00Z');

test('the countdown runs down over the five minutes between scans', () => {
  const fresh = scanClock(T0, '2026-11-23T16:00:00Z', true);
  assert.equal(fresh.until, 300);
  assert.equal(countdownWords(fresh), 'Next scan in 5:00');
  const later = scanClock(T0 + 137000, '2026-11-23T16:00:00Z', true);
  assert.equal(countdownWords(later), 'Next scan in 2:43');
  assert.ok(later.fraction > fresh.fraction);
});

test('the ring fills from empty to full across the cycle and never past it', () => {
  assert.equal(scanClock(T0, '2026-11-23T16:00:00Z', true).fraction, 0);
  assert.equal(scanClock(T0 + 150000, '2026-11-23T16:00:00Z', true).fraction, 0.5);
  assert.equal(scanClock(T0 + 900000, '2026-11-23T16:00:00Z', true).fraction, 1);
});

test('a late scan says it is due rather than counting into negative numbers', () => {
  const overdue = scanClock(T0 + 420000, '2026-11-23T16:00:00Z', true);
  assert.equal(overdue.state, 'due');
  assert.equal(overdue.until, 0);
  assert.equal(countdownWords(overdue), 'Next scan due now');
});

test('a closed market counts down to nothing, because nothing is coming', () => {
  const shut = scanClock(T0 + 60000, '2026-11-23T16:00:00Z', false);
  assert.equal(shut.state, 'closed');
  assert.equal(shut.until, null);
  assert.equal(countdownWords(shut), 'Next scan when the market reopens');
  assert.equal(elapsedWords(shut), 'Last scan 1 min ago');
});

test('an unreadable or future scan time says so instead of inventing a clock', () => {
  for (const at of [undefined, '', 'not a date', '2026-11-23T16:00:00', '2026-11-24T16:00:00Z']) {
    const c = scanClock(T0, at, true);
    assert.equal(c.state, 'unknown', String(at));
    assert.equal(countdownWords(c), 'Scan time unavailable');
    assert.equal(elapsedWords(c), 'Last scan time unavailable');
  }
});

test('the live clock never claims the prices are live', () => {
  assert.match(appJsSource, /The clock is live\. The prices are not/);
  // The per-second timer must only patch text, never re-render the page.
  assert.match(appJsSource, /visibilityState === "visible"\) tickScanClock\(\);\n\s*\}, 1000\)/);
  assert.doesNotMatch(clockSrc, /render\(/, 'the scan clock must not trigger a render');
});

test('the account total sits above the workspace deck, not below it', () => {
  const body = appJsSource.slice(appJsSource.indexOf('<div class="v2 command-view">'));
  const order = ['${hero}', '${workspaceDeck()}', '${activityDeck()}'].map((s) => body.indexOf(s));
  assert.ok(order[0] > -1 && order[0] < order[1], 'Casey should not scroll past a headline to reach his balance');
  assert.ok(order[1] < order[2]);
});

test('the radar card shows one age, and it is the live one', () => {
  // It used to render a frozen "Scan N min ago" in the header while the clock
  // below kept counting, so the same card disagreed with itself within seconds.
  const card = appJsSource.slice(appJsSource.indexOf('function workspaceDeck()'), appJsSource.indexOf('function activityDeck()'));
  assert.doesNotMatch(card, /MARKET RADAR · \$\{/, 'no render-time age in the radar header');
  assert.doesNotMatch(card, /Scan \$\{age/, 'no frozen age string anywhere on the card');
  assert.match(card, /data-scan-elapsed/, 'the age must come from the ticking element');
});

test('nothing rendered carries an inline style attribute, which the CSP drops', () => {
  // This has bitten twice: chart bars drew as slivers, and the scan ring shipped
  // with style="--fraction" that production would have silently discarded. The
  // policy is default-src 'none' with style-src 'self' and no unsafe-inline, so a
  // style attribute in markup is parsed and ignored. Geometry goes in SVG
  // attributes or CSS classes; anything dynamic is set through CSSOM.
  const states = [{}, {radar:{generated_at:'2026-11-23T15:58:00Z',candidate_count:0,market:{is_open:true}},server_time:Date.parse('2026-11-23T16:00:00Z')}];
  for (const s of states) {
    const html = render(s);
    assert.doesNotMatch(html, /\sstyle\s*=\s*["']/, 'rendered markup must not set style attributes');
  }
  assert.match(appJsSource, /setProperty\("--fraction"/, 'the ring fill must be set through CSSOM');
});

// Casey asked to understand what he is looking at. These pin the honesty of the
// figures: no meaning carried by colour alone, no invented numbers, and the
// disagreement between R and money kept visible rather than resolved into one
// flattering line.
const labState = {
  research: {
    window: { start: '2026-07-26', end: '2026-11-23' },
    how_trades_ended: [
      { label: 'Target hit', trades: 113, share_pct: 11.4, avg_r: 2.06 },
      { label: 'Stopped out', trades: 553, share_pct: 55.8, avg_r: -1.19 },
      { label: 'Closed at session end', trades: 323, share_pct: 32.6, avg_r: 0.11 },
    ],
    stop_sweep: [
      { stop_pct: 1, avg_r: -0.263, avg_dollars: -0.105 },
      { stop_pct: 20, avg_r: -0.024, avg_dollars: -0.194 },
    ],
  },
};

test('every segment of the lab figures is labelled, so colour never carries it alone', () => {
  const html = render(labState);
  for (const bit of ['11.4%', '55.8%', '32.6%', 'target hit', 'stopped out', '113 trades']) {
    assert.ok(html.includes(bit), `missing ${bit}`);
  }
});

test('the lab figures keep R and money side by side instead of picking the kind one', () => {
  const html = render(labState);
  assert.match(html, /Judged by R/);
  assert.match(html, /Judged by money/);
  assert.match(html, /−\$0\.19/, 'the money bars must show the loss');
  assert.match(html, /-0\.02/, 'the R bars must show the flattering number too');
  assert.match(html, /R is measured in units of your stop/);
});

test('the lab card says what it rests on and never predicts', () => {
  const html = render(labState);
  assert.match(html, /2026-07-26/);
  assert.match(html, /not what any trade will do/);
  assert.match(html, /983|1,?\d{3}|989|\d+ trades/);
});

test('missing lab data renders nothing rather than an empty frame', () => {
  assert.ok(!render({}).includes('What the lab found'));
  assert.ok(!render({ research: { how_trades_ended: [], stop_sweep: [] } }).includes('What the lab found'));
});

test('no bar label is drawn outside its own chart box', () => {
  // The tallest bar's value label clipped off the top of the viewBox. Only
  // visible by looking at it, so it gets an invariant rather than another look.
  const html = render(labState);
  for (const svg of html.match(/<svg viewBox="0 0 [\d.]+ (\d+)"[\s\S]*?<\/svg>/g) || []) {
    const height = Number(svg.match(/viewBox="0 0 [\d.]+ (\d+)"/)[1]);
    for (const m of svg.matchAll(/<(?:text|rect)[^>]*\sy="([-\d.]+)"/g)) {
      const y = Number(m[1]);
      assert.ok(y >= 0 && y <= height, `y=${y} outside 0..${height}`);
    }
  }
});
