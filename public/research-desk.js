// Research tools use the Hub's saved observations and explicit external sources.
// No third-party scripts, tracking pixels, browser credentials, or trade endpoints.
(() => {
  "use strict";
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const symbol = v => /^[A-Z][A-Z0-9.-]{0,14}$/.test(String(v || "").trim().toUpperCase()) ? String(v).trim().toUpperCase() : "";
  const link = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}<span class="sr-only"> (opens a new tab)</span></a>`;
  const safeUrl = value => {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password ? u.href : null; } catch { return null; }
  };
  const dated = value => typeof value === "string" && /[Tt ].*(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  function age(value, now) {
    if (!dated(value)) return "time unavailable";
    const elapsed = now - Date.parse(value);
    if (elapsed < 0) return "timestamp ahead of this sync";
    const minutes = Math.floor(elapsed / 60000);
    return minutes < 1 ? "under a minute ago" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`;
  }
  const CATEGORIES = [
    ["all", "All angles"], ["news", "News & filings"], ["macro", "Politics & economy"],
    ["tape", "Day trading"], ["short", "Short interest"], ["options", "Options"], ["owners", "Who owns what"],
  ];
  // These are source destinations, not ingested data. Their own timestamps govern.
  const SOURCES = [
    ["news", "SEC EDGAR", "Company filings", "8-K events, earnings, capital raises, prospectuses and financial statements. Compare the filing with the headline.", "https://www.sec.gov/search-filings", "Official · free"],
    ["news", "Nasdaq earnings", "Earnings calendar", "Check the scheduled report and confirm timing with the company's investor relations page.", "https://www.nasdaq.com/market-activity/earnings", "Exchange · confirm dates"],
    ["news", "FDA", "Health and biotech catalysts", "Announcements and regulatory decisions. A planned decision date is different from an approval.", "https://www.fda.gov/news-events", "Official · free"],
    ["macro", "Federal Reserve", "Fed calendar", "Meetings, scheduled releases and speeches. Check event time and the published statement.", "https://www.federalreserve.gov/newsevents/calendar.htm", "Official · free"],
    ["macro", "BLS", "Inflation and jobs", "CPI, employment and other releases. Check the release timezone and any revised schedule.", "https://www.bls.gov/schedule/news_release/", "Official · free"],
    ["macro", "BEA", "GDP and consumer spending", "GDP and Personal Income and Outlays release schedule.", "https://www.bea.gov/news/schedule", "Official · free"],
    ["macro", "Census Bureau", "Housing, retail and industry", "Economic indicators and release calendar for demand-sensitive sectors.", "https://www.census.gov/economic-indicators/", "Official · free"],
    ["macro", "Treasury", "Sanctions and fiscal policy", "Read the official release and effective date before linking a policy to a stock.", "https://home.treasury.gov/news/press-releases", "Official · free"],
    ["macro", "Federal Register", "Rules and executive documents", "Separate proposals, final rules and effective dates. Search the affected sector or agency.", "https://www.federalregister.gov/", "Official · free"],
    ["macro", "White House", "Presidential actions", "Primary documents on policy. Check implementation dates and independent reporting for context.", "https://www.whitehouse.gov/presidential-actions/", "Official · free"],
    ["macro", "CME FedWatch", "Rate expectations", "Futures-implied probabilities for Fed decisions; expectations can change with prices.", "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool", "Exchange · external tool"],
    ["tape", "Nasdaq Trader", "Trading halts", "Check halt reason and resumption details before relying on a chart or quote.", "https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalts", "Exchange · check timestamp"],
    ["tape", "NYSE", "Market hours and holidays", "Confirm the session, holiday closures and early closes.", "https://www.nyse.com/markets/hours-calendars", "Exchange · free"],
    ["tape", "TradingView", "Charts and screeners", "Compare volume, VWAP, support, resistance and the broader market. Feed delays and paid tiers vary.", "https://www.tradingview.com/", "External · free/paid tiers"],
    ["short", "FINRA", "Reported short interest", "Outstanding short positions by reporting date. Check settlement and publication dates.", "https://www.finra.org/finra-data/browse-catalog/equity-short-interest", "Official · periodic reports"],
    ["short", "FINRA", "Daily short sale volume", "Trading-volume data, not outstanding short positions. Do not read the ratio as the percent of a company sold short.", "https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data", "Official · daily files"],
    ["options", "Cboe", "Options market statistics", "Exchange volume and put/call context. A high volume print alone does not reveal who opened, closed or hedged.", "https://www.cboe.com/markets/us/options/market-statistics", "Exchange · check coverage"],
    ["options", "Options Industry Council", "Options education", "Contract mechanics, pricing, exercise, assignment and the risks of expiration.", "https://www.optionseducation.org/optionsoverview/options-basics", "Industry education · free"],
    ["owners", "House Clerk", "House financial disclosures", "Read transaction dates and disclosure dates separately. Reported ranges do not give exact entry prices.", "https://disclosures-clerk.house.gov/FinancialDisclosure", "Official · delayed disclosures"],
    ["owners", "U.S. Senate", "Senate financial disclosures", "Search periodic transaction reports. Site access requires agreeing to its terms.", "https://efdsearch.senate.gov/search/home/", "Official · delayed disclosures"],
    ["owners", "SEC EDGAR", "Insiders and institutions", "Form 4 insider transactions and 13F institutional holdings. Holdings snapshots do not reveal a fund's complete book or current trades.", "https://www.sec.gov/search-filings", "Official · filing dates matter"],
  ];
  const CHECKS = [
    ["news", "Why is it moving?", "Find the original release. Record publication, first seen and decision times; check dilution, guidance and earnings."],
    ["macro", "What could interrupt it?", "Check policy announcements, rates, inflation, jobs and scheduled releases. Identify which revenue, cost or valuation channel affects this company."],
    ["tape", "Can the price be traded?", "Check the session, quote age, bid/ask spread, dollar volume, relative volume, VWAP, levels and halts. Thin quotes can erase a small target."],
    ["short", "Is positioning crowded?", "Compare short interest with float and average daily volume using matching dates. Borrow availability, fees and recall risk require broker data."],
    ["options", "What is the options market pricing?", "Check expiration, strike, bid/ask, volume, prior open interest, implied volatility and earnings. Distinguish a large print from an opening directional bet."],
    ["owners", "How old is the disclosure?", "Record transaction date, filing date and any amendment. Insider sales may be scheduled; institutional filings show a past snapshot."],
  ];
  function symbols(state) {
    return [...new Set([...(state.board?.snapshot?.positions || []), ...(state.radar?.candidates || []), ...(state.radar?.quotes || [])].map(x => symbol(x.symbol)).filter(Boolean))].slice(0, 20);
  }
  function news(state, picked) {
    const seen = new Set();
    return (state.radar?.candidates || []).filter(c => !picked || symbol(c.symbol) === picked).flatMap(c => {
      if (!c.news?.headline) return [];
      const key = c.news.url || `${c.symbol}:${c.news.headline}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{...c.news, symbol:symbol(c.symbol)}];
    }).slice(0, 12);
  }
  function costModel(position, target, stop, cost) {
    if (![position,target,stop,cost].every(Number.isFinite) || position <= 0 || target <= 0 || stop <= 0 || stop >= 100 || cost < 0) return null;
    const gain = position * (target-cost)/100, loss = position * (stop+cost)/100;
    return {gain, loss, breakEven:gain > 0 ? loss / (gain+loss)*100 : null};
  }
  function policyPanel(report, now) {
    return `<section class="intel-policy"><div class="intel-section-title"><h2>Policy documents</h2><span>FederalRegister.gov · public API</span></div><p class="intel-caption">Recent documents across agencies, not filtered to a stock or ranked by market impact. Publication dates are calendar dates; first availability and intraday timing are not supplied here. Confirm legal text in the linked official publication.</p><button id="research-policy-refresh" class="btn" type="button">Read recent policy documents</button>${!report ? `<p class="intel-empty">Not read this session. Read the public source when you need policy context.</p>` : `<p class="intel-caption">Source checked ${esc(age(report.checked_at,now))} · ${esc(report.checked_at)}${report.cached ? " · cached for up to 10 minutes" : ""}.</p>${report.problem ? `<p class="intel-empty" role="status">Policy source unavailable: ${esc(report.problem)} Use the Federal Register source link below.</p>` : (report.items || []).length ? report.items.map(item=>`<article class="intel-policy-item"><span>${esc(item.type)} · Published ${esc(item.publication_date || "date unavailable")}${item.effective_on ? ` · Effective ${esc(item.effective_on)}` : ""}</span><h3>${safeUrl(item.url) ? link(safeUrl(item.url),item.title) : esc(item.title)}</h3><p>${esc((item.agencies || []).join(" · ") || "Agency not reported")}</p></article>`).join("") : `<p class="intel-empty">No readable documents were returned. This does not mean there are no policy events.</p>`}`}</section>`;
  }
  function render(state, selected = "", category = "all") {
    const picked = symbol(selected), now = state.server_time || Date.now();
    const radar = state.radar, candidates = radar?.candidates || [];
    const c = candidates.find(x => symbol(x.symbol) === picked);
    const q = (radar?.quotes || []).find(x => symbol(x.symbol) === picked);
    const stories = news(state, picked);
    const groups = CATEGORIES.filter(([id]) => id !== "all" && (category === "all" || category === id));
    const usd = n => n == null ? "Not reported" : `$${Number(n).toFixed(2)}`;
    const metric = (name, value, explanation) => `<div class="intel-metric"><span>${esc(name)}</span><strong>${esc(value)}</strong><small>${esc(explanation)}</small></div>`;
    // Every metric here comes from a saved scan. When the scanner has not covered
    // this symbol there is nothing to read, and the dossier used to answer with
    // four boxes all reading "Not reported" and no word about why. Casey asked for
    // a symbol and got a wall of blanks, which reads as broken rather than empty.
    const nothingSaved = !c && !q?.available;
    const sec = picked ? `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(picked)}` : "https://www.sec.gov/search-filings";
    return `<section class="intel-desk" aria-label="Trading research desk">
      <div class="intel-top"><div><p class="deck-eyebrow">THE RESEARCH DESK</p><h1>Every angle.<br><em>Better questions.</em></h1><p>Connect the catalyst, market conditions and positioning before building a plan.</p></div><div class="intel-emblem" aria-hidden="true">NEWS<span>POLICY · PRICE · POSITIONING</span></div></div>
      <div class="intel-coverage"><span>Saved watcher observations</span><span>External source library</span><span>Scenario calculator</span></div>
      <p class="intel-caption">Headlines and prices below come from saved scans. Source buttons open external sites; they are not connected feeds. Options, short-interest and disclosure data have not been imported.</p>
      <form id="research-symbol-form" class="intel-search"><label for="research-symbol">Focus on a symbol</label><div><input id="research-symbol" name="symbol" maxlength="15" placeholder="e.g. QQQ" value="${esc(picked)}" autocomplete="off" autocapitalize="characters" spellcheck="false" pattern="[A-Za-z][A-Za-z0-9.\\-]{0,14}"><button class="btn primary" type="submit">Research</button><button class="btn" type="button" data-research-symbol="">All symbols</button></div></form>
      <div class="intel-symbols" aria-label="Symbols from saved Hub data">${symbols(state).map(s => `<button type="button" data-research-symbol="${esc(s)}" aria-pressed="${s === picked}">${esc(s)}</button>`).join("")}</div>
      ${picked ? `<div class="intel-focus"><h2>${esc(picked)} dossier</h2><p class="intel-caption">Scan ${esc(age(radar?.generated_at,now))}${radar?.generated_at ? ` · ${esc(radar.generated_at)}` : ""}.${nothingSaved ? "" : " Metrics are observations from that scan."}</p>${nothingSaved
        ? `<div class="intel-blank"><p><b>No saved scan has covered ${esc(picked)}.</b> The prices on this desk come from the watcher's own scans, and ${esc(picked)} was not in ${radar?.generated_at ? `the last one, ${esc(age(radar.generated_at, now))}` : "any scan the Hub has received"}. That is why there are no numbers here, rather than the numbers being zero.</p>
            <p>It fills in on its own once ${esc(picked)} turns up in a scan: the watcher covers the most active names and the biggest movers each pass. The links below do not depend on it and work now.</p></div>`
        : `<div class="intel-metrics">${metric("Price", c ? usd(c.price) : usd(q.price), c ? "Candidate observation" : q?.at ? `Quote ${age(q.at,now)}` : "Saved quote")}${metric("Day move", c?.day_move_pct == null ? "Not reported" : `${c.day_move_pct}%`, "Compared with prior close")}${metric("Relative volume", c?.relative_volume == null ? "Not reported" : `${c.relative_volume}×`, "Watcher's reported comparison")}${metric("Spread", c?.spread_pct == null ? "Not reported" : `${c.spread_pct}%`, "Saved bid/ask spread")}</div>`}<div class="intel-focus-links">${link(sec,"Search company filings")}${link(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(picked)}`,"Open chart")}${link(`https://finance.yahoo.com/quote/${encodeURIComponent(picked)}/options/`,"Open options chain")}</div><p class="intel-caption">Chart and chain providers may require a login or carry delayed data. Verify the exchange, quote timestamp and contract before using a value.</p></div>` : ""}
      <div class="intel-headlines"><div class="intel-section-title"><h2>News in the saved scan</h2><span>${stories.length} shown · ${esc(age(radar?.generated_at,now))}</span></div>${stories.length ? stories.map(n => `<article><div class="intel-news-meta"><strong>${esc(n.symbol)}</strong><span>Published ${esc(age(n.published_at,now))}</span></div><h3>${safeUrl(n.url) ? link(safeUrl(n.url), n.headline) : esc(n.headline)}</h3><p>First seen: ${esc(n.first_seen_at || "not recorded")} · Publication: ${esc(n.published_at || "not recorded")}</p><p>${esc(n.basis || "Headline timing was not assessed.")}</p></article>`).join("") : `<p class="intel-empty">${picked ? `No saved candidate headline for ${esc(picked)}.` : "The last candidate scan contains no headlines."} This is not a complete news search. Check company releases and filings in the source library.</p>`}</div>
      ${policyPanel(state.policy,Math.max(now,Date.now()))}
      <nav class="intel-filters" aria-label="Research topics">${CATEGORIES.map(([id,label]) => `<button class="btn" type="button" data-research-category="${id}" aria-pressed="${category === id}">${label}</button>`).join("")}</nav>
      <div class="intel-source-grid">${groups.map(([id,label]) => `<section class="intel-source-group" data-resource-group="${id}"><p class="deck-eyebrow">${esc(label)}</p><h2>${esc(CHECKS.find(x=>x[0]===id)[1])}</h2><p class="intel-question">${esc(CHECKS.find(x=>x[0]===id)[2])}</p>${SOURCES.filter(x=>x[0]===id).map(([,name,title,description,url,access])=>`<article class="intel-source"><div><h3>${link(url,title)}</h3><span>${esc(name)} · ${esc(access)}</span></div><p>${esc(description)}</p></article>`).join("")}</section>`).join("")}</div>
      <section class="intel-scenario"><p class="deck-eyebrow">PUT IT IN DOLLARS</p><h2>What must the setup overcome?</h2><p>Model a long stock or ETF position. Enter an all-in round-trip cost assumption for spread, slippage and fees; these are assumptions, not a broker quote.</p><form id="research-cost-form"><div class="intel-calculator"><label>Position ($)<input name="position" type="number" min="0.01" max="1000000" step="any" value="5" required></label><label>Target gain (%)<input name="target" type="number" min="0.01" max="1000" step="any" value="10" required></label><label>Stop distance (%)<input name="stop" type="number" min="0.01" max="99.99" step="any" value="20" required></label><label>Round-trip cost (%)<input name="cost" type="number" min="0" max="100" step="any" value="0.2" required></label></div><button class="btn" type="submit">Calculate scenario</button><output id="research-cost-result" aria-live="polite">At $5, a 10% target and 20% stop with 0.2% assumed costs: net target $0.49, modeled stop loss $1.01, break-even win rate 67.3%.</output></form><p class="intel-caption">Two-outcome illustration only; partial exits and time exits change the answer. A stop can fill beyond its trigger. This calculator does not size options or short positions, determine account capacity, or change a plan.</p></section>
      <section class="intel-handoff"><h2>Build the evidence before the plan</h2><p>Save the original source, when it was published, when it was first seen, the quote time, the case against the idea, and the event that would invalidate it. Compare with the lab's unseen results below.</p><p class="intel-caption">Current instrument rules: ${esc(state.board?.rules?.instruments || "not reported")}. Broader research does not change the trading rules.</p><button class="btn" type="button" data-tab-link="trades">Open trade plans</button></section>
    </section>`;
  }
  globalThis.HubResearchDesk = {render, symbol, symbols, news, costModel, safeUrl, SOURCES, CATEGORIES};
})();
