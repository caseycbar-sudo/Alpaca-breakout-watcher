/**
 * Driftline Swing Watchdog — runs 24/7 inside a Google Sheet (Apps Script).
 *
 * What it does
 *   watch()  — every hour: pulls daily prices for QQQ and BTC, applies the current
 *              trend rule (price above its N-day average = HOLD, else CASH), logs it,
 *              and emails you when a signal flips or is about to.
 *   learn()  — every Sunday: scores every allowed average length three ways — the last
 *              3 years, the last year, and FORWARD (only days since this watchdog
 *              started, which no setting was ever tuned on). It never changes the
 *              live setting by itself. When one length has beaten the current one
 *              on forward data for 6+ months, it emails a SUGGESTION; you approve it
 *              by editing the Settings tab. Why: in the lab, auto-switching to the
 *              recent winner every week cut BTC returns from ~34% to ~20% a year
 *              (it chases noise). Forward-only evidence is the honest test.
 *   aiNote() — after learn(), if an Anthropic API key is saved, asks Claude for a short
 *              plain-English weekly note. Commentary only: it cannot change settings.
 *
 * It never places trades. The Claude "Driftline Swing" routine reads the Settings tab
 * and does the trading on Robinhood under the hard limits (no margin, $20 positions).
 *
 * Setup: Extensions → Apps Script, paste this file, Save, run setup() once, approve.
 */

// ---------------------------------------------------------------- configuration
var ASSETS = {
  QQQ: {
    source: 'yahoo', ticker: 'QQQ', label: 'QQQ (Nasdaq-100)',
    lengths: [100, 125, 150, 175, 200, 225, 250],   // allowed range, all tested in the lab
    start: 200,                                      // lab default
    feePerSide: 0.0003, perYear: 252,
  },
  BTC: {
    source: 'coinbase', ticker: 'BTC-USD', label: 'Bitcoin',
    lengths: [30, 40, 50, 60, 80, 100, 150, 200],
    start: 50,
    feePerSide: 0.0052, perYear: 365,                // 0.50% maker + slippage
  },
};

// LEARNING RULES — the guardrails that keep "learning" from chasing noise.
var LEARN = {
  minSharpeEdge: 0.15,   // challenger must beat the current setting's Sharpe by this much...
  minForwardDays: 180,   // ...on at least 6 months of forward (never-tuned-on) data
  nearFlipPct: 1.5,      // warn when price is within 1.5% of its average
};

var TABS = {
  dash: 'Dashboard', log: 'Log', settings: 'Settings', learning: 'Learning', ai: 'AI Notes',
};

// ---------------------------------------------------------------- pure math (testable)
function sma(xs, n, i) {
  if (i < n - 1) return null;
  var s = 0;
  for (var k = i - n + 1; k <= i; k++) s += xs[k];
  return s / n;
}

/** Trend backtest on closes: in the market on day i+1 if close[i] > sma(n)[i]. */
function backtest(closes, n, feePerSide, perYear) {
  var eq = 1, inMkt = false, trades = 0, rets = [], peak = 1, maxDD = 0;
  for (var i = n - 1; i < closes.length - 1; i++) {
    var want = closes[i] > sma(closes, n, i);
    if (want !== inMkt) { eq *= (1 - feePerSide); inMkt = want; trades++; }
    var r = inMkt ? closes[i + 1] / closes[i] - 1 : 0;
    eq *= (1 + r);
    rets.push(r);
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
  }
  var days = rets.length;
  if (days < 20) return null;
  var mean = rets.reduce(function (a, b) { return a + b; }, 0) / days;
  var sd = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / days);
  return {
    sharpe: sd > 0 ? mean / sd * Math.sqrt(perYear) : 0,
    cagr: Math.pow(eq, perYear / days) - 1,
    maxDD: maxDD,
    trades: trades,
  };
}

/** Score a length on a trailing window (needs n extra days of history for the average). */
function scoreWindow(closes, n, windowDays, cfg) {
  var from = Math.max(0, closes.length - windowDays - n);
  return backtest(closes.slice(from), n, cfg.feePerSide, cfg.perYear);
}

/**
 * Champion/challenger scoring. Never changes anything; returns a suggestion.
 * forwardDays = days of price history since the watchdog started.
 */
function decide(closes, cfg, champion, forwardDays) {
  var y3 = cfg.perYear * 3, y1 = cfg.perYear;
  var fwd = Math.min(forwardDays, closes.length);
  var table = cfg.lengths.map(function (n) {
    var a = scoreWindow(closes, n, y3, cfg), b = scoreWindow(closes, n, y1, cfg);
    var f = fwd >= 20 ? scoreWindow(closes, n, fwd, cfg) : null;
    return { n: n, s3: a ? a.sharpe : -99, s1: b ? b.sharpe : -99, sf: f ? f.sharpe : null };
  });
  var champ = table.filter(function (r) { return r.n === champion; })[0];
  var res = { suggest: false, champ: champ, table: table };
  if (!champ) { res.best = table[0]; res.reason = 'current setting is outside the allowed range — check Settings'; return res; }
  var ranked = table.filter(function (r) { return r.sf !== null; }).sort(function (a, b) { return b.sf - a.sf; });
  res.best = ranked[0] || table.slice().sort(function (a, b) { return b.s3 - a.s3; })[0];
  if (fwd < LEARN.minForwardDays) {
    res.reason = 'collecting forward data: ' + fwd + ' of ' + LEARN.minForwardDays + ' days (history leader: ' +
      table.slice().sort(function (a, b) { return b.s3 - a.s3; })[0].n + '-day)';
  } else if (res.best.n === champion) {
    res.reason = 'current setting leads on forward data';
  } else if (res.best.sf - champ.sf < LEARN.minSharpeEdge) {
    res.reason = res.best.n + '-day leads forward by only ' + (res.best.sf - champ.sf).toFixed(2) + ' Sharpe — keep';
  } else if (res.best.s1 < champ.s1) {
    res.reason = res.best.n + '-day leads forward but trails on the last year — keep';
  } else {
    res.suggest = true;
    res.reason = res.best.n + '-day has beaten ' + champion + '-day by ' + (res.best.sf - champ.sf).toFixed(2) +
      ' Sharpe over ' + fwd + ' forward days and on the last year — SUGGESTION, needs Casey\'s OK';
  }
  return res;
}

// ---------------------------------------------------------------- data
function fetchJson_(url) {
  for (var attempt = 0; attempt < 3; attempt++) {
    var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.getResponseCode() === 200) return JSON.parse(r.getContentText());
    Utilities.sleep(1500 * (attempt + 1));
  }
  throw new Error('fetch failed: ' + url);
}

/** Daily closes, oldest first: [{d:'YYYY-MM-DD', c:Number}] */
function dailyCloses(cfg) {
  if (cfg.source === 'yahoo') {
    var r = fetchJson_('https://query1.finance.yahoo.com/v8/finance/chart/' + cfg.ticker +
                       '?range=5y&interval=1d').chart.result[0];
    var adj = r.indicators.adjclose[0].adjclose;
    var out = [];
    for (var i = 0; i < r.timestamp.length; i++) {
      if (adj[i]) out.push({ d: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), c: adj[i] });
    }
    return out;
  }
  // Coinbase: 300 candles per call, walk back ~4.5 years
  var byDay = {}, end = new Date();
  for (var page = 0; page < 6; page++) {
    var start = new Date(end.getTime() - 299 * 864e5);
    var rows = fetchJson_('https://api.exchange.coinbase.com/products/' + cfg.ticker +
      '/candles?granularity=86400&start=' + start.toISOString() + '&end=' + end.toISOString());
    rows.forEach(function (k) { byDay[k[0]] = k[4]; });   // [time, low, high, open, close, vol]
    end = start;
    Utilities.sleep(400);
  }
  return Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; })
    .map(function (t) { return { d: new Date(t * 1000).toISOString().slice(0, 10), c: byDay[t] }; });
}

// ---------------------------------------------------------------- sheet helpers
function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }
function props_() { return PropertiesService.getScriptProperties(); }
function me_() { return Session.getEffectiveUser().getEmail(); }

function getSetting_(asset) {
  var rows = sheet_(TABS.settings).getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) if (rows[i][0] === asset) return { row: i + 1, n: Number(rows[i][1]), changed: rows[i][3] };
  return null;
}

// ---------------------------------------------------------------- setup
function setup() {
  var ss = SpreadsheetApp.getActive();
  var heads = {};
  heads[TABS.dash] = ['Asset', 'Signal', 'Price', 'Average', 'Length (days)', 'Distance %', 'Updated'];
  heads[TABS.log] = ['Time', 'Asset', 'Price', 'Average', 'Length', 'Distance %', 'Signal'];
  heads[TABS.settings] = ['Asset', 'Length (days)', 'Allowed range', 'Last changed', 'Why'];
  heads[TABS.learning] = ['Date', 'Asset', 'Current length', 'Leader', 'Current Sharpe 3y / 1y / forward', 'Leader Sharpe 3y / 1y / forward', 'Decision', 'Reason'];
  heads[TABS.ai] = ['Date', 'Weekly note from Claude'];
  Object.keys(heads).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(heads[name]);
      sh.getRange(1, 1, 1, heads[name].length).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  var st = sheet_(TABS.settings);
  Object.keys(ASSETS).forEach(function (a) {
    if (!getSetting_(a)) {
      var c = ASSETS[a];
      st.appendRow([a, c.start, c.lengths[0] + '–' + c.lengths[c.lengths.length - 1],
                    new Date(), 'starting value from the backtest lab']);
    }
  });
  var first = ss.getSheets()[0];
  if (first.getName() !== TABS.dash && first.getLastRow() === 0) ss.deleteSheet(first);

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('watch').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('learn').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(18).create();
  watch();
  learn();
}

// ---------------------------------------------------------------- hourly watch
function watch() {
  var p = props_(), now = new Date(), dash = [];
  Object.keys(ASSETS).forEach(function (a) {
    var cfg = ASSETS[a], set = getSetting_(a), n = set ? set.n : cfg.start;
    try {
      var bars = dailyCloses(cfg), xs = bars.map(function (b) { return b.c; });
      var avg = sma(xs, n, xs.length - 1), px = xs[xs.length - 1];
      var dist = (px / avg - 1) * 100, sig = px > avg ? 'HOLD' : 'CASH';
      sheet_(TABS.log).appendRow([now, a, px, avg, n, Math.round(dist * 100) / 100, sig]);
      dash.push([cfg.label, sig, px, avg, n, Math.round(dist * 100) / 100, now]);

      var last = p.getProperty('sig_' + a);
      if (last && last !== sig) {
        MailApp.sendEmail(me_(), 'Driftline: ' + a + ' flipped to ' + sig,
          a + ' is now ' + (sig === 'HOLD' ? 'ABOVE' : 'BELOW') + ' its ' + n + '-day average (' +
          dist.toFixed(1) + '%). Price ' + px.toFixed(2) + ', average ' + avg.toFixed(2) +
          '.\nThe Claude Swing routine acts on this at its next 3:45 p.m. ET run.');
      }
      p.setProperty('sig_' + a, sig);

      var today = now.toISOString().slice(0, 10);
      if (Math.abs(dist) < LEARN.nearFlipPct && p.getProperty('near_' + a) !== today) {
        MailApp.sendEmail(me_(), 'Driftline: ' + a + ' is close to flipping',
          a + ' is ' + dist.toFixed(2) + '% from its ' + n + '-day average. A signal change may come soon.');
        p.setProperty('near_' + a, today);
      }
      p.deleteProperty('err_' + a);
    } catch (e) {
      dash.push([cfg.label, 'DATA ERROR', '', '', n, '', now]);
      if (!p.getProperty('err_' + a)) {   // one email per outage, not one per hour
        MailApp.sendEmail(me_(), 'Driftline watchdog: data error for ' + a, String(e));
        p.setProperty('err_' + a, '1');
      }
    }
  });
  var d = sheet_(TABS.dash);
  if (d.getLastRow() > 1) d.getRange(2, 1, d.getLastRow() - 1, 7).clearContent();
  d.getRange(2, 1, dash.length, 7).setValues(dash);
  trimLog_();
}

function trimLog_() {
  var sh = sheet_(TABS.log), extra = sh.getLastRow() - 1 - 5000;   // keep ~3 months of hourly rows
  if (extra > 0) sh.deleteRows(2, extra);
}

// ---------------------------------------------------------------- weekly learning
function learn() {
  var p = props_(), summary = [];
  if (!p.getProperty('started')) p.setProperty('started', new Date().toISOString());
  var started = new Date(p.getProperty('started'));
  Object.keys(ASSETS).forEach(function (a) {
    var cfg = ASSETS[a], set = getSetting_(a), cur = set ? set.n : cfg.start;
    try {
      var bars = dailyCloses(cfg), xs = bars.map(function (b) { return b.c; });
      var startDay = started.toISOString().slice(0, 10);
      var fwd = bars.filter(function (b) { return b.d >= startDay; }).length;
      var res = decide(xs, cfg, cur, fwd);
      var c = res.champ || { s3: 0, s1: 0, sf: null };
      var fmt = function (r) { return r.s3.toFixed(2) + ' / ' + r.s1.toFixed(2) + ' / ' + (r.sf === null ? '–' : r.sf.toFixed(2)); };
      sheet_(TABS.learning).appendRow([new Date(), a, cur, res.best.n, fmt(c), fmt(res.best),
        res.suggest ? 'SUGGEST ' + res.best.n : 'keep', res.reason]);
      if (res.suggest && p.getProperty('suggested_' + a) !== String(res.best.n)) {
        MailApp.sendEmail(me_(), 'Driftline suggestion: ' + a + ' ' + cur + '-day → ' + res.best.n + '-day',
          res.reason + '\n\nNothing changes unless you edit the Settings tab (or tell Claude).');
        p.setProperty('suggested_' + a, String(res.best.n));
      }
      summary.push({ asset: a, current: cur, forwardDays: fwd, suggestion: res.suggest ? res.best.n : null,
                     reason: res.reason, table: res.table });
    } catch (e) {
      sheet_(TABS.learning).appendRow([new Date(), a, cur, '', '', '', 'ERROR', String(e)]);
    }
  });
  aiNote_(summary);
}

// ---------------------------------------------------------------- optional Claude weekly note
/**
 * Optional. To turn on: Apps Script → Project Settings → Script properties →
 * add ANTHROPIC_API_KEY. Costs a few cents a week. Commentary only.
 */
function aiNote_(summary) {
  var key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) return;
  var recent = sheet_(TABS.log).getLastRow() > 1
    ? sheet_(TABS.log).getRange(Math.max(2, sheet_(TABS.log).getLastRow() - 335), 1,
        Math.min(336, sheet_(TABS.log).getLastRow() - 1), 7).getValues() : [];
  var prompt =
    'You are the weekly analyst for a tiny ($60) trend-following account that holds QQQ while it is above ' +
    'its moving average and BTC while it is above its moving average. Write a short weekly note (under 180 words, ' +
    'plain words, no jargon) for the owner: where each asset sits vs its average, whether the weekly ' +
    'scoreboard suggests anything and why, and what would make a signal flip. Do not recommend trades, position ' +
    'sizes or rule changes; the rules are fixed.\n\nWeekly re-test results:\n' + JSON.stringify(summary) +
    '\n\nLast week of hourly log rows [time, asset, price, average, length, distance %, signal]:\n' +
    JSON.stringify(recent.filter(function (_, i) { return i % 6 === 0; }));
  var r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', muteHttpExceptions: true, contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01',
               'anthropic-beta': 'server-side-fallback-2026-07-01' },
    payload: JSON.stringify({
      model: 'claude-opus-5-5', max_tokens: 2000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  var body = JSON.parse(r.getContentText());
  var text = r.getResponseCode() !== 200 ? 'API error: ' + r.getContentText().slice(0, 300)
    : body.stop_reason === 'refusal' ? '(no note this week)'
    : body.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
  sheet_(TABS.ai).appendRow([new Date(), text]);
  MailApp.sendEmail(me_(), 'Driftline weekly note', text);
}

// Node test hook (ignored by Apps Script)
if (typeof module !== 'undefined') module.exports = { sma: sma, backtest: backtest, decide: decide, ASSETS: ASSETS };
