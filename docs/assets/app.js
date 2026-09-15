const state={data:null};
const $=id=>document.getElementById(id);
const money=(v,d=2)=>`${Number(v)<0?'-':''}$${Math.abs(Number(v||0)).toFixed(d)}`;
const num=(v,d=2)=>Number(v||0).toFixed(d);
const pct=v=>`${num(v,1)}%`;
const when=value=>{if(!value)return 'Not available';const date=new Date(value);return Number.isNaN(date.valueOf())?value:date.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
const esc=value=>String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

function setView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  window.scrollTo({top:0,behavior:'smooth'});
}

function renderCandidates(rows){
  $('roster-count').textContent=`${Math.min(rows.length,3)} / 3`;
  $('radar-count').textContent=`${rows.length} candidate${rows.length===1?'':'s'}`;
  $('radar-message').textContent=rows.length?'Every name shown cleared the automated market-data gate. Private Robinhood and primary-source verification still follow.':'No ticker currently clears every price, volume, VWAP, RSI, spread, catalyst and confirmation gate. Silence is a decision—not a system failure.';
  if(!rows.length){$('candidate-list').innerHTML='<div class="empty-state"><div class="empty-icon">◎</div><strong>No forced trades</strong><p>The radar is active. It will populate only when a setup earns a place on the board.</p></div>';return;}
  $('candidate-list').innerHTML=rows.slice(0,3).map(row=>`<article class="candidate"><div class="ticker">${esc(row.symbol)}</div><div class="signal"><small>${esc(row.stage||row.confirmation||'candidate')}</small><strong>${money(row.price,2)}</strong></div><div class="datum"><small>MOVE</small><strong>${Number(row.day_move_pct)>=0?'+':''}${num(row.day_move_pct)}%</strong></div><div class="datum"><small>RVOL</small><strong>${num(row.relative_volume)}x</strong></div><div class="datum"><small>TRIGGER</small><strong>${money(row.breakout_level,2)}</strong></div><div class="arrow">›</div></article>`).join('');
}

function renderResearch(rows){
  if(!rows.length){$('research-log').innerHTML='<div class="empty-state"><div class="empty-icon">⌁</div><strong>No qualifying research event yet</strong><p>The watcher is checking; the log records candidates and meaningful stage changes rather than flooding you with noise.</p></div>';return;}
  $('research-log').innerHTML=rows.map(row=>`<article class="timeline-item ${row.kind==='stage change'?'amber':''}"><div class="timeline-meta"><span>${esc(row.symbol)}</span><span>${when(row.time)}</span><span>${esc(row.kind)}</span></div><h3>${esc(row.title)}</h3><p>${esc(row.detail)}</p>${row.source_url?`<a href="${esc(row.source_url)}" target="_blank" rel="noreferrer">Open source ↗</a>`:''}</article>`).join('');
}

function renderPaper(paper){
  const ret=Number(paper.balance)-Number(paper.starting_balance);
  $('balance').textContent=money(paper.balance);$('paper-balance').textContent=money(paper.balance);$('trade-count').textContent=paper.completed_trades;$('open-count').textContent=`${paper.open_trades} open`;$('win-rate').textContent=pct(paper.win_rate);$('expectancy').textContent=money(paper.expectancy);$('drawdown').textContent=money(paper.maximum_drawdown);$('paper-return').textContent=`${ret>=0?'+':''}${money(ret)} all-time`;
  $('validation-pill').textContent=paper.validated?'VALIDATION THRESHOLD REACHED':'NOT YET VALIDATED';
  $('paper-stats').innerHTML=[['Average win',money(paper.average_win)],['Average loss',money(paper.average_loss)],['Profit factor',paper.profit_factor==null?'—':num(paper.profit_factor)],['Expectancy',money(paper.expectancy)],['Max drawdown',money(paper.maximum_drawdown)],['Completed',paper.completed_trades]].map(([k,v])=>`<div class="stat-cell"><small>${k.toUpperCase()}</small><strong>${v}</strong></div>`).join('');
  const values=[50];let running=50;[...(paper.trades||[])].reverse().filter(t=>t.status==='closed').forEach(t=>{running+=Number(t.net_pl||0);values.push(running)});while(values.length<18)values.push(values[values.length-1]);const min=Math.min(...values)-.2,max=Math.max(...values)+.2;$('equity-chart').innerHTML=values.map(v=>`<i style="height:${Math.max(8,(v-min)/(max-min)*100)}%"></i>`).join('');
  const trades=paper.trades||[];$('trade-rows').innerHTML=trades.length?trades.map(t=>`<tr><td><strong>${esc(t.symbol)}</strong><br><small>${esc(t.trade_id)}</small></td><td>${esc(t.setup)}</td><td class="mono">${money(t.entry,4)}<br><small>${money(t.size)} size</small></td><td class="mono">${money(t.stop,4)} / ${money(t.target,4)}</td><td class="mono">${t.exit?money(t.exit,4):'—'}<br><small>${esc(t.reason)}</small></td><td class="mono ${Number(t.net_pl)<0?'loss':Number(t.net_pl)>0?'gain':''}">${t.net_pl?money(t.net_pl):'—'}</td><td><span class="status-pill">${esc(t.status)}</span></td></tr>`).join(''):'<tr><td colspan="7"><div class="empty-state"><strong>No completed simulations yet</strong><p>The lab will not invent a fill. A trade appears only after every entry rule is satisfied.</p></div></td></tr>';
}

function render(data){
  state.data=data;const system=data.system||{},market=data.market||{},paper=data.paper_lab||{};
  $('last-scan').textContent=data.generated_at?when(data.generated_at):'Awaiting first run';$('watcher-status').textContent=system.watcher||'unknown';$('watcher-dot').style.background=system.watcher==='online'?'var(--cyan)':'var(--amber)';$('market-phase').textContent=market.phase||'unknown';$('data-feed').textContent=system.market_data||'—';$('bridge-status').textContent=system.email_bridge||'—';$('next-open').textContent=market.is_open?`Close ${when(market.next_close)}`:`Open ${when(market.next_open)}`;
  renderCandidates(data.candidates||[]);renderResearch(data.research_log||[]);renderPaper(paper);
  $('gate-grid').innerHTML=(data.gates||[]).map(g=>`<div class="gate"><strong>${esc(g.label)}</strong><span>${esc(g.rule)}</span></div>`).join('');
  $('connection-alpaca').textContent=`${system.watcher||'unknown'} · ${system.market_data||'market data'}`;$('connection-stocktwits').textContent=system.stocktwits||'not checked';$('connection-sec').textContent=system.sec_edgar||'not checked';$('connection-halts').textContent=system.nasdaq_halts||'not checked';$('connection-email').textContent=system.email_bridge||'standing by';$('connection-paper').textContent=`${paper.completed_trades||0} completed · ${paper.open_trades||0} open`;
  $('privacy-grid').innerHTML=Object.entries(data.privacy||{}).map(([key,value])=>`<article class="privacy-card"><small>${key.replaceAll('_',' ').toUpperCase()}</small><p>${esc(value)}</p></article>`).join('');
}

async function load(showToast=false){
  try{const response=await fetch(`data/dashboard.json?v=${Date.now()}`,{cache:'no-store'});if(!response.ok)throw new Error('data unavailable');render(await response.json());if(showToast)toast('Dashboard refreshed');}
  catch(error){$('watcher-status').textContent='data unavailable';$('watcher-dot').style.background='var(--amber)';toast('Could not refresh—showing the last loaded view');}
}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2600)}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
document.querySelectorAll('[data-jump]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.jump)));
$('refresh').addEventListener('click',()=>load(true));
load();setInterval(()=>load(false),120000);
