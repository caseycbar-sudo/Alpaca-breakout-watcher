/* Driftline Backtest Lab view. Shared by the Command Center tab and the Mac report. */
(function(){
  const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const n=(v,d=2)=>Number(v||0).toFixed(d);
  const r=v=>`${Number(v)>0?'+':''}${n(v)}R`;
  const money=v=>`${Number(v)<0?'-':Number(v)>0?'+':''}$${Math.abs(Number(v||0)).toFixed(2)}`;
  const tone=v=>Number(v)>0?'gain':Number(v)<0?'loss':'';
  const day=v=>{if(!v)return '—';const d=new Date(String(v).length<=10?`${v}T12:00:00`:v);return Number.isNaN(d.valueOf())?esc(v):d.toLocaleDateString([], {month:'short',day:'numeric'})};
  const clock=v=>{if(!v)return '';const d=new Date(v);return Number.isNaN(d.valueOf())?'':d.toLocaleTimeString([], {hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})+' ET'};
  const setupShort=s=>String(s||'').split(' — ')[0];
  const safeUrl=u=>/^https?:\/\//i.test(String(u||''))?String(u):'';
  const badge=(text,kind='')=>`<span class="bt-badge ${kind}">${esc(text)}</span>`;
  const evidenceKind=e=>e==='strong'?'strong':e==='moderate'?'moderate':'weak';

  function empty(root,title,message){
    root.innerHTML=`<div class="section-intro"><div><span class="eyebrow">RESEARCH ONLY</span><h2>Backtest lab</h2><p>Replays your A/B/C setups on past market data so you can learn what tends to work. It never changes live alerts or paper trades.</p></div></div><article class="panel bt-panel"><div class="empty-state"><div class="empty-icon">◷</div><strong>${esc(title)}</strong><p>${esc(message)}</p></div></article>`;
  }

  function patternList(rows,kind){
    if(!rows||!rows.length)return `<div class="empty-state"><strong>Nothing has earned this list yet</strong><p>${kind==='promising'?'No condition beat the average on both the learning days and the unseen check days.':'No condition clearly lost on both the learning days and the unseen check days.'}</p></div>`;
    const item=p=>`<li><div class="bt-pattern-name">${esc(p.pattern)}</div><div class="bt-pattern-stats"><span><small>LEARNING DAYS</small><b class="${tone(p.train.avg_r)}">${r(p.train.avg_r)}</b> · ${p.train.n} trades · ${n(p.train.win_rate,0)}% win</span><span><small>UNSEEN CHECK DAYS</small><b class="${tone(p.test.avg_r)}">${r(p.test.avg_r)}</b> · ${p.test.n} trades · ${n(p.test.win_rate,0)}% win</span></div>${badge(p.evidence+' evidence',evidenceKind(p.evidence))}</li>`;
    const first=rows.slice(0,5),rest=rows.slice(5);
    return `<ol class="bt-patterns">${first.map(item).join('')}</ol>${rest.length?`<details class="bt-more"><summary>Show ${rest.length} more</summary><ol class="bt-patterns">${rest.map(item).join('')}</ol></details>`:''}`;
  }

  function statCells(items){return items.map(([k,v,sub,cls])=>`<article><small>${esc(k)}</small><strong class="${cls||''}">${v}</strong><span>${sub}</span></article>`).join('')}

  function spark(values){
    if(!values||values.length<2)return '<div class="bt-spark-empty">The equity line appears once paper-rule trades exist.</div>';
    const w=600,h=120,min=Math.min(...values),max=Math.max(...values),span=(max-min)||1;
    const pts=values.map((v,i)=>`${(i/(values.length-1)*w).toFixed(1)},${(h-8-(v-min)/span*(h-16)).toFixed(1)}`).join(' ');
    const base=(h-8-(values[0]-min)/span*(h-16)).toFixed(1);
    return `<svg class="bt-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Paper-rule equity from ${money(values[0]).replace('+','')} to ${money(values[values.length-1]).replace('+','')}"><line x1="0" x2="${w}" y1="${base}" y2="${base}" class="bt-spark-base"/><polyline points="${pts}" class="bt-spark-line"/></svg>`;
  }

  function render(data,root){
    if(!data||!data.summary){empty(root,'No backtest yet','The nightly backtest has not published results yet. It runs after the market closes on weekdays.');return;}
    const s=data.summary,L=s.learning||{},P=s.portfolio||{},m=data.model||{},pat=data.patterns||{},w=data.window||{};
    const modelLabel={useful:'MODEL: A LEAD TO WATCH',faint:'MODEL: FAINT SIGNAL','no edge':'MODEL: NO EDGE YET',waiting:'MODEL: NEEDS MORE HISTORY'}[m.status]||'MODEL: —';
    const features=[...new Set((data.buckets||[]).map(b=>b.feature))];
    const labelFor=f=>((data.buckets||[]).find(b=>b.feature===f)||{}).feature_label||f;

    root.innerHTML=`
    <div class="section-intro"><div><span class="eyebrow">RESEARCH ONLY · UPDATED ${esc(day(data.generated_at))}</span><h2>Backtest lab</h2><p>Replays your A/B/C setups on ${s.tickers} tickers from ${day(w.start)} to ${day(w.end)} (${w.trading_days||0} trading days). It learns on the older ${pat.train_days||0} days, then checks itself on the newest ${pat.test_days||0} days it never saw. Results are in <b>R</b>: +1R made what the trade risked, −1R hit the stop.</p></div><div class="validation-pill">${esc(modelLabel)}</div></div>

    <section class="metrics bt-metrics" aria-label="Backtest summary">${statCells([
      ['TICKERS STUDIED',s.tickers,`${(data.study_list||[]).filter(x=>String(x.source).includes('watcher')).length} from the watcher`],
      ['SETUPS REPLAYED',L.trades||0,'every A/B/C shape, gates or not'],
      ['AVERAGE RESULT',r(L.avg_r),`${n(L.win_rate,1)}% finished green`,tone(L.avg_r)],
      ['PAPER-RULE TRADES',P.trades||0,P.trades?`${money(P.net_pl)} on $50 · ${n(P.win_rate,0)}% win`:'passed every replayable gate',P.trades?tone(P.net_pl):''],
      ['MODEL CHECK',m.test_auc!=null?n(m.test_auc,2):'—','0.50 = coin flip · unseen days'],
    ])}</section>

    <div class="bt-grid">
      <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">HELD UP ON UNSEEN DAYS</span><h3>What has tended to work</h3></div><span class="count-badge">${(pat.promising||[]).length}</span></div>${patternList(pat.promising,'promising')}</article>
      <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">LOST ON BOTH PERIODS</span><h3>What has tended to fail</h3></div><span class="count-badge bt-amber">${(pat.avoid||[]).length}</span></div>${patternList(pat.avoid,'avoid')}</article>
    </div>
    <p class="bt-footnote">Average for all setups: ${r((pat.baseline||{}).train?.avg_r)} on learning days, ${r((pat.baseline||{}).test?.avg_r)} on check days. ${pat.patterns_tested||0} patterns were tested, so a few will look good by luck — the check days are there to catch that.</p>

    <div class="bt-grid">
      <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">SECOND OPINION</span><h3>Simple learning model</h3></div></div>
        <p class="bt-verdict">${esc(m.verdict||'')}</p>
        ${m.test_auc!=null?`<div class="bt-mini"><div><small>LEARNING DAYS SCORE</small><b>${n(m.train_auc,2)}</b></div><div><small>UNSEEN DAYS SCORE</small><b>${n(m.test_auc,2)}</b></div><div><small>ITS TOP THIRD</small><b class="${tone(m.top_third_avg_r)}">${r(m.top_third_avg_r)}</b></div><div><small>ITS BOTTOM THIRD</small><b class="${tone(m.bottom_third_avg_r)}">${r(m.bottom_third_avg_r)}</b></div></div>
        <h4 class="bt-sub">What the model leans on</h4><ul class="bt-factors">${(m.factors||[]).map(f=>`<li><span>${esc(f.effect)}</span><i style="--w:${Math.min(100,Math.abs(f.weight)*120)}%" class="${f.weight>0?'pos':'neg'}"></i></li>`).join('')||'<li><span>No factor stood out.</span></li>'}</ul>`:`<p class="bt-muted">${m.train_trades||0} learning trades · ${m.test_trades||0} check trades so far.</p>`}
      </article>
      <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">DO THE LIVE GATES HELP?</span><h3>Gate check</h3></div></div>
        <p class="bt-muted">Setups that passed each live rule vs. setups that failed it.</p>
        <div class="table-scroll"><table class="bt-table bt-compact"><thead><tr><th>Gate</th><th>Passed</th><th>Failed</th><th>Verdict</th></tr></thead><tbody>${(pat.gate_review||[]).map(g=>`<tr><td>${esc(g.gate.charAt(0).toUpperCase()+g.gate.slice(1))}</td><td class="mono ${tone(g.passed.avg_r)}">${r(g.passed.avg_r)} <small>(${g.passed.n})</small></td><td class="mono ${tone(g.failed.avg_r)}">${r(g.failed.avg_r)} <small>(${g.failed.n})</small></td><td>${badge(g.verdict,g.verdict==='helping'?'strong':g.verdict==='not helping'?'amber':'weak')}</td></tr>`).join('')||'<tr><td colspan="4">Not enough setups yet.</td></tr>'}</tbody></table></div>
      </article>
    </div>

    <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">SETUP SCORECARD</span><h3>A, B and C measured separately</h3></div><span class="bt-muted">${s.validated?'100+ paper-rule trades per setup':'Needs 100+ paper-rule trades per setup before trusting it'}</span></div>
      <div class="table-scroll"><table class="bt-table"><thead><tr><th>Setup</th><th>All shapes</th><th>Win rate</th><th>Avg</th><th>Profit factor</th><th>Paper-rule trades</th><th>Paper-rule net</th></tr></thead><tbody>${(s.by_setup||[]).map(x=>`<tr><td><strong>${esc(setupShort(x.setup))}</strong> <small>${esc(String(x.setup).split(' — ')[1]||'')}</small></td><td class="mono">${x.learning.trades}</td><td class="mono">${n(x.learning.win_rate,1)}%</td><td class="mono ${tone(x.learning.avg_r)}">${r(x.learning.avg_r)}</td><td class="mono">${x.learning.profit_factor==null?'—':n(x.learning.profit_factor)}</td><td class="mono">${x.portfolio.trades}</td><td class="mono ${tone(x.portfolio.net_pl)}">${x.portfolio.trades?money(x.portfolio.net_pl):'—'}</td></tr>`).join('')}</tbody></table></div>
    </article>

    <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">TICKER BY TICKER</span><h3>How each stock has behaved</h3></div><span class="bt-muted">Tap a row for details</span></div>
      <div class="bt-tickers">${(data.tickers||[]).map(t=>`<details class="bt-ticker"><summary><span class="bt-sym">${esc(t.symbol)}</span><span class="bt-cell"><small>SETUPS</small>${t.learning.trades}</span><span class="bt-cell"><small>WIN</small>${n(t.learning.win_rate,0)}%</span><span class="bt-cell ${tone(t.learning.avg_r)}"><small>AVG</small>${r(t.learning.avg_r)}</span><span class="bt-cell bt-hide-sm"><small>STOPPED / TARGET</small>${n(t.stop_rate,0)}% / ${n(t.target_rate,0)}%</span><span class="bt-note">${esc(t.note)}</span></summary>
        <div class="bt-ticker-body"><p class="bt-muted">Source: ${esc(((data.study_list||[]).find(x=>x.symbol===t.symbol)||{}).source||'—')} · ${t.days_with_data} days of data · news archive ${esc(t.news)} · average best move before exit ${r(t.avg_best_r)} · paper-rule trades ${t.portfolio_trades}${t.portfolio_trades?` (${money(t.portfolio_net_pl)})`:''}</p>
        ${t.highlights&&t.highlights.length?`<ul class="bt-highlights">${t.highlights.map(h=>`<li>${esc(h)}</li>`).join('')}</ul>`:'<p class="bt-muted">Not enough setups to single out a best or worst condition.</p>'}
        ${t.recent&&t.recent.length?`<div class="table-scroll"><table class="bt-table"><thead><tr><th>Date</th><th>Setup</th><th>Entry → exit</th><th>Why it ended</th><th>Result</th></tr></thead><tbody>${t.recent.map(x=>`<tr><td>${day(x.date)} <small>${clock(x.entry_time)}</small></td><td>${esc(setupShort(x.setup))}${x.strict?' '+badge('all gates','strong'):''}</td><td class="mono">$${n(x.entry,x.entry<5?4:2)} → $${n(x.exit,x.exit<5?4:2)}</td><td>${esc(x.exit_reason)}</td><td class="mono ${tone(x.r_multiple)}">${r(x.r_multiple)}</td></tr>`).join('')}</tbody></table></div>`:''}</div></details>`).join('')||'<div class="empty-state"><strong>No tickers studied yet</strong></div>'}</div>
    </article>

    <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">EVERY CONDITION</span><h3>Pattern explorer</h3></div><label class="bt-select"><span class="sr-only">Condition</span><select id="bt-feature">${features.map(f=>`<option value="${esc(f)}">${esc(labelFor(f))}</option>`).join('')}</select></label></div>
      <div class="table-scroll"><table class="bt-table"><thead><tr><th>Condition</th><th>Learning days</th><th>Check days</th><th>Verdict</th></tr></thead><tbody id="bt-bucket-rows"></tbody></table></div>
    </article>

    <div class="bt-grid">
      <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">PAPER LAB RULES</span><h3>$50 account, $10 positions</h3></div><span class="bt-muted">${P.trades?`Max drawdown $${n(P.max_drawdown)}`:''}</span></div>${spark(data.equity_curve)}
        <p class="bt-muted">Only setups that passed every replayable gate, with the live limits: 3 entries a day, stop after 2 losses.</p></article>
      <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">NIGHT BY NIGHT</span><h3>Is the learning stable?</h3></div></div>
        <div class="table-scroll"><table class="bt-table bt-compact"><thead><tr><th>Run</th><th>Tickers</th><th>Setups</th><th>Avg</th><th>Model</th></tr></thead><tbody>${[...(data.history||[])].reverse().slice(0,8).map(h=>`<tr><td>${day(h.generated_at)}${h.run==='chosen tickers'?' <small>(hand-picked)</small>':''}</td><td class="mono">${h.tickers}</td><td class="mono">${h.learning_trades}</td><td class="mono ${tone(h.learning_avg_r)}">${r(h.learning_avg_r)}</td><td class="mono">${h.model_test_auc==null?'—':n(h.model_test_auc,2)}</td></tr>`).join('')}</tbody></table></div>
        <p class="bt-muted">A pattern that keeps showing up night after night deserves more trust than one that appears once.</p></article>
    </div>

    <article class="panel bt-panel"><div class="panel-heading"><div><span class="eyebrow">PAPER-RULE TRADES</span><h3>Most recent simulated trades</h3></div></div>
      <div class="table-scroll"><table class="bt-table"><thead><tr><th>Ticker</th><th>Entry</th><th>Setup</th><th>Entry → exit</th><th>Why it ended</th><th>Result</th><th>Catalyst</th></tr></thead><tbody>${(data.portfolio_trades||[]).map(t=>`<tr><td><strong>${esc(t.symbol)}</strong></td><td>${day(t.date)} <small>${clock(t.entry_time)}</small></td><td>${esc(setupShort(t.setup))}</td><td class="mono">$${n(t.entry,t.entry<5?4:2)} → $${n(t.exit,t.exit<5?4:2)}</td><td>${esc(t.exit_reason)}</td><td class="mono ${tone(t.net_pl)}">${r(t.r_multiple)}<br><small>${money(t.net_pl)}</small></td><td>${safeUrl(t.catalyst_url)?`<a href="${esc(safeUrl(t.catalyst_url))}" target="_blank" rel="noreferrer">${esc(t.catalyst_headline||'source')}</a>`:esc(t.catalyst_headline||'—')}</td></tr>`).join('')||'<tr><td colspan="7"><div class="empty-state"><strong>No setup passed every gate in this window</strong><p>That matches the live rules: silence is a decision.</p></div></td></tr>'}</tbody></table></div>
    </article>

    <article class="panel bt-panel bt-caveats"><span class="eyebrow">READ THIS BEFORE TRUSTING A NUMBER</span>
      <ul>${(data.caveats||[]).map(c=>`<li>${esc(c)}</li>`).join('')}</ul>
      <p class="bt-muted">Modeled spread ${n((data.assumptions||{}).modeled_spread_pct,2)}% · slippage ${n((data.assumptions||{}).slippage_pct,2)}% · entry: ${esc((data.assumptions||{}).entry)} · exit: ${esc((data.assumptions||{}).exit)}.</p>
      ${(data.errors||[]).length?`<p class="bt-muted">Data notes: ${data.errors.map(esc).join(' · ')}</p>`:''}
    </article>`;

    const select=root.querySelector('#bt-feature'),body=root.querySelector('#bt-bucket-rows');
    const fill=()=>{const rows=(data.buckets||[]).filter(b=>b.feature===select.value).sort((a,b)=>b.train.n-a.train.n);body.innerHTML=rows.map(b=>`<tr><td>${esc(b.bucket)}</td><td class="mono"><span class="${tone(b.train.avg_r)}">${r(b.train.avg_r)}</span> <small>${b.train.n} · ${n(b.train.win_rate,0)}%</small></td><td class="mono"><span class="${tone(b.test.avg_r)}">${r(b.test.avg_r)}</span> <small>${b.test.n} · ${n(b.test.win_rate,0)}%</small></td><td>${badge(b.verdict,b.verdict==='promising'?'strong':b.verdict==='avoid'?'amber':'weak')}</td></tr>`).join('')||'<tr><td colspan="4">No data.</td></tr>'};
    if(select){select.addEventListener('change',fill);fill();}
  }

  window.DriftlineBacktest={render,empty};
})();

