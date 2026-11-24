// Driftline Trading Hub: Casey's page.
// Plain JavaScript, no framework, no build step. Everything shown comes from /api/state.
// Anything typed by an AI is escaped before it reaches the page.

(() => {
  "use strict";

  const view = document.getElementById("view");
  if (!view) return; // sign-in and setup pages load the stylesheet only

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const TABS = ["today", "jobs", "chat", "trades", "research", "rules", "ais"];

  let S = null; // latest state from the server
  let tab = TABS.includes(sessionStorage.getItem("tab")) ? sessionStorage.getItem("tab") : "today";
  let olderChat = []; // pages loaded with "Show earlier messages"
  let hasOlder = false;
  let lastRendered = { key: "", tab: "" };
  let openHistories = new Set();
  let historyCache = {};
  let expandedMessages = new Set();
  let researchSymbol = "";
  let researchCategory = "all";
  let researchCostDraft = null;
  let researchCostResult = "";
  let researchPolicy = null;

  // ------------------------------------------------------------ helpers

  async function api(path, body) {
    const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Hub": "1" }, body: JSON.stringify(body) };
    const res = await fetch(path, { credentials: "same-origin", ...opts });
    if (res.status === 401) {
      location.href = "/sign-in";
      throw new Error("Signed out");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "That did not work. Try again.");
    return data;
  }

  let toastTimer;
  function toast(text, bad) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const el = document.createElement("div");
    el.className = "toast" + (bad ? " bad" : "");
    el.setAttribute("role", "status");
    el.textContent = text;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), bad ? 6000 : 2600);
  }

  const money = (n) => (n === null || n === undefined ? null : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const price = (n) => (n === null || n === undefined ? "Not set" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }));

  function ago(ms) {
    if (!ms) return "never";
    const mins = Math.max(0, Math.round((S.server_time - ms) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }

  function clock(ms) {
    const d = new Date(ms);
    const sameDay = new Date(S.server_time).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
  }

  function shortDate(text) {
    if (!text) return "Not set";
    const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return text;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const count = (n, one, many) => `${n === 1 ? "One" : n} ${n === 1 ? one : many}`;

  // Words Casey can tap for a plain explanation.
  const GLOSSARY = {
    "total value": ["Total value", "Everything in the account added together: cash plus what your shares are worth right now. It moves all day as prices move."],
    cash: ["Cash", "Money in the account that is not in any stock. This is what you can actually spend on a new trade."],
    "buying power": ["Buying power", "How much the broker says you could buy right now. In an account with no borrowing it should equal your cash. If it is ever higher than cash, borrowed money may be available, and the hub will flag it."],
    today: ["Today's change", "How much the account is up or down since the last market close, as the AI saw it when it checked. It is a snapshot, not a live number."],
    position: ["Position", "A stock or fund you currently own. Two positions means you own two different things at once."],
    stop: ["Stop order", "An order that sits at the broker and sells automatically if the price falls to a level you chose. It limits a loss while nobody is watching. It does not guarantee the price: if the stock drops suddenly, it can sell lower than the level."],
    "limit order": ["Limit order", "An order to buy only at your price or better. It waits at the broker until the price gets there. Reaching the price does not guarantee it fills."],
    "daily stop": ["Daily stop", "Your rule that once the account is down a set amount on the day, no new orders go in until tomorrow. It is checked when an AI looks, not every second, so it limits new trades but cannot cap a loss by itself."],
    snapshot: ["Snapshot", "A reading of your account that an AI took at one moment and reported here. The hub has no live line to the broker, so the board always shows how old the reading is."],
    stale: ["Out of date", "The last account reading is more than two hours old. Treat the numbers as history until an AI reports a fresh one."],
    plan: ["Trade plan", "A written idea for one trade: what to buy, at what price, where to take profit, where to get out if wrong, and how much to put in. It is posted before anything is bought."],
    review: ["Review", "A second AI checks a plan before it reaches you. The one who wrote a plan cannot review it. A review is advice to you, not permission to trade."],
    approve: ["Your approval", "Only you can approve a plan, and only from this page. Your approval covers the plan exactly as written. If the price, size or stock changes afterward, the approval is cleared and it comes back to you."],
    fill: ["Fill", "When an order actually goes through at the broker. An order can fill fully, partly, or not at all."],
    engine: ["Trading engine", "A program that would watch prices all day and place orders by fixed rules. None is running. Nothing in this hub can place an order."],
    connector: ["Connector", "The door your AIs use to reach this hub. Each AI has its own pass that you approved, and you can cut off any one of them at any time."],
  };
  const term = (key, text) => `<button type="button" class="term" data-term="${esc(key)}">${esc(text ?? GLOSSARY[key][0].toLowerCase())}</button>`;

  function openSheet(title, html) {
    $("#sheet-title").textContent = title;
    $("#sheet-body").innerHTML = html;
    $("#sheet").hidden = false;
    $("#sheet-close").focus();
  }
  $("#sheet-close").addEventListener("click", () => ($("#sheet").hidden = true));
  $("#sheet").addEventListener("click", (e) => {
    if (e.target.id === "sheet") $("#sheet").hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#sheet").hidden = true;
  });

  // A small, safe Markdown reader for chat messages. Escapes first, then adds structure.
  function markdown(src) {
    const blocks = [];
    let text = String(src).replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const inline = (line) =>
      esc(line)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      const code = line.match(/^\u0000(\d+)\u0000$/);
      const head = line.match(/^#{1,6}\s+(.*)$/);
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (code) {
        flushPara(); flushList(); out.push(blocks[Number(code[1])]);
      } else if (!line.trim()) {
        flushPara(); flushList();
      } else if (head) {
        flushPara(); flushList(); out.push(`<h4>${inline(head[1])}</h4>`);
      } else if (bullet || numbered) {
        flushPara();
        const tag = bullet ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        list = list || { tag, items: [] };
        list.items.push(inline((bullet || numbered)[1]));
      } else if (/^\s*-{3,}\s*$/.test(line)) {
        flushPara(); flushList();
      } else {
        flushList(); para.push(inline(line));
      }
    }
    flushPara(); flushList();
    return out.join("");
  }

  const AGENT_COLORS = { claude: "#b5651d", chatgpt: "#2a6a4c", grok: "#4b3f8f" };
  const colorFor = (id) => AGENT_COLORS[id] || "#1b6e8c";

  // ------------------------------------------------------------ project jobs
  let jobOwner = "all", jobStatus = "active", extraJobs = [], jobsCursor = null, jobsPaged = false;
  const people = { "": "Unassigned", casey: "Casey", chatgpt: "ChatGPT", claude: "Claude", grok: "Grok" };
  const jobStates = { proposed: "Proposed", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "Needs review", done: "Done", canceled: "Canceled" };
  function options(values, selected) { return Object.entries(values).map(([id,label]) => `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(label)}</option>`).join(""); }
  function allJobs() { return [...new Map([...extraJobs, ...(S.jobs?.tasks || [])].map(t=>[t.id,t])).values()]; }
  function jobStats() {
    const c = S.jobs?.counts || {};
    return `<div class="job-stats"><div><strong>${c.in_progress || 0}</strong>in progress</div><div><strong>${c.blocked || 0}</strong>blocked</div><div><strong>${c.review || 0}</strong>need review</div></div>`;
  }
  function jobCard(t) {
    const actions = { handoff: "Propose a handoff", cancel: "Cancel task" };
    if (t.status === "proposed" && (!t.owner_id || t.owner_id === "casey")) actions.accept = "Accept this task myself";
    if (t.owner_id === "casey") {
      if (["ready","blocked"].includes(t.status)) actions.start = "Start work";
      if (t.status === "in_progress") { actions.progress = "Record progress"; actions.submit = "Submit evidence for review"; }
      if (["ready","in_progress","blocked"].includes(t.status)) actions.block = "Record a blocker";
    }
    if (t.status === "review" && t.owner_id !== "casey") { actions.complete = "Review and mark done"; actions.rework = "Request changes"; }
    const closed = ["done","canceled"].includes(t.status);
    return `<article class="job-card" data-status="${esc(t.status)}" id="job-${t.id}">
      <div class="job-card-top"><span class="job-tag">#${t.id} · ${esc(t.project)}</span><span class="priority ${esc(t.priority)}">${esc(t.priority)}</span></div>
      <h3>${esc(t.title)}</h3>
      <div class="job-meta">
        <strong class="status-pill ${esc(t.status)}">${esc(jobStates[t.status])}</strong>
        <span class="who"><i class="av av-${esc(t.owner_id || "casey")}">${esc((people[t.owner_id] || "Casey").slice(0, 1))}</i>${esc(people[t.owner_id] || t.owner_id || "Casey")}${t.status === "proposed" ? " · not accepted" : ""}</span>
        <span class="who quiet"><i class="av av-${esc(t.reviewer_id || "casey")}">${esc((people[t.reviewer_id] || "Casey").slice(0, 1))}</i>reviews</span>
      </div>
      <p class="job-copy job-next"><strong>Next:</strong> ${esc(t.next_action)}</p>
      ${t.blocker ? `<p class="banner job-copy"><strong>Blocked:</strong> ${esc(t.blocker)}</p>` : ""}
      ${t.stale ? `<p class="meta">No update in over 24 hours. Check whether the owner can continue.</p>` : ""}
      <details class="job-detail"><summary>What this job is${t.dependencies.length ? ", what it depends on" : ""} and how it will be judged</summary>
        <p class="job-copy">${esc(t.description)}</p>
        <h4 class="job-h4">Judged by</h4><p class="job-copy">${esc(t.acceptance)}</p>
        ${t.dependencies.length ? `<p class="meta">Depends on: ${t.dependencies.map(id=>`#${id}`).join(", ")}</p>` : ""}
        ${t.evidence ? `<h4 class="job-h4">Submitted evidence</h4><p class="job-copy">${esc(t.evidence)}</p>` : ""}
      </details>
      ${!closed ? `<details><summary>Update or hand off</summary>
        <form class="formgrid" data-job-update="${t.id}" data-version="${t.version}">
          <label>Action<select name="action">${options(actions, t.status === "review" && t.owner_id !== "casey" ? "complete" : t.status === "proposed" && (!t.owner_id || t.owner_id === "casey") ? "accept" : "handoff")}</select></label>
          <label>Progress or review note<textarea name="note" maxlength="2000" required rows="2"></textarea></label>
          <label>Next action (needed except accepting, completing or canceling)<textarea name="next_action" maxlength="1000" rows="2"></textarea></label>
          <label>Blocker (when blocking)<textarea name="blocker" maxlength="2000" rows="2"></textarea></label>
          <label>Evidence (when submitting for review)<textarea name="evidence" maxlength="4000" rows="2" placeholder="Commit, test results, observed behavior, and any limits"></textarea></label>
          <label>New owner (handoffs only)<select name="owner_id">${options(people, "")}</select></label>
          <button class="btn primary" type="submit">Save task update</button>
        </form></details>` : ""}
      <p class="meta">Updated ${esc(ago(t.updated_at))} · version ${t.version} · <button type="button" class="linkish" data-job-history="${t.id}">View history</button></p>
    </article>`;
  }
  function workloadHtml() {
    return `<div class="team-grid">${["chatgpt","claude","grok"].map(id=>{
      const assigned=allJobs().filter(t=>t.owner_id===id && !["done","canceled"].includes(t.status));
      const accepted=assigned.filter(t=>t.status!=="proposed");
      const seen=S.connections.find(c=>c.agent_id===id);
      return `<button type="button" class="team-tile" data-job-owner="${id}" aria-label="Show ${people[id]} jobs">
        <span class="agent-avatar ${id}">${id==="chatgpt"?"Ch":id==="claude"?"Cl":"G"}</span>
        <span class="team-name">${people[id]}<small>${seen?.last_seen ? `Last seen ${esc(ago(seen.last_seen))}` : "Not checked in recently"}</small></span>
        <span class="team-load"><b>${accepted.length}</b> accepted <span>· ${assigned.length-accepted.length} proposed</span></span>
      </button>`;
    }).join("")}</div>`;
  }
  function renderJobs() {
    const all = allJobs().sort((a,b)=>({high:0,normal:1,low:2}[a.priority]-{high:0,normal:1,low:2}[b.priority]) || a.id-b.id);
    const jobs = all.filter(t=>(jobOwner === "all" || t.owner_id === jobOwner) && (jobStatus === "all" || (jobStatus === "active" ? !["done","canceled"].includes(t.status) : t.status === jobStatus)));
    return `<section class="section jobs-section"><div class="job-hero"><h1>Good ideas.<br><em>Visible progress.</em></h1>
      <p class="sub">The job list for your whole team. Know who owns the next move.</p>${jobStats()}</div>
      <div class="section-heading"><div><h2>Your team’s work</h2></div><span class="quiet small-copy">Tap a teammate to filter</span></div>
      ${workloadHtml()}
      <details class="gloss workflow-note"><summary>How work moves</summary><p>Propose → accept → work → review → done. An assignment becomes a commitment when its owner accepts. Completed work needs evidence and an independent review. Agents work when their sessions run; the queue does not keep them online or grant permission for external actions.</p></details>
      <details class="gloss job-create"><summary><span aria-hidden="true">＋</span> Create a job</summary><form id="job-form" class="formgrid">
        <label>Job title<input name="title" maxlength="180" required></label>
        <label>Project<input name="project" maxlength="120" value="Hub improvements" required></label>
        <label>What needs doing<textarea name="description" maxlength="4000" rows="3" required></textarea></label>
        <label>How we will know it is done<textarea name="acceptance" maxlength="2000" rows="3" required></textarea></label>
        <div class="pair"><label>Proposed owner<select name="owner_id">${options(people, "")}</select></label><label>Independent reviewer<select name="reviewer_id">${options({"":"Casey",chatgpt:"ChatGPT",claude:"Claude",grok:"Grok"}, "")}</select></label></div>
        <label>Priority<select name="priority">${options({high:"High",normal:"Normal",low:"Low"}, "normal")}</select></label>
        <label>Next concrete action<textarea name="next_action" maxlength="1000" rows="2" required></textarea></label>
        <label>Dependency task numbers, separated by commas<input name="dependencies" inputmode="numeric" placeholder="For example: 1, 2"></label>
        <button class="btn primary" type="submit">Create job proposal</button>
      </form></details>
      <div class="job-toolbar"><label>Owner<select id="job-owner">${options({all:"Everyone",...people}, jobOwner)}</select></label><label>Status<select id="job-status">${options({active:"Open work",all:"All statuses",...jobStates}, jobStatus)}</select></label></div>
      <div class="jobs-grid">${jobs.length ? jobs.map(jobCard).join("") : `<div class="empty">No jobs match this view.${S.jobs?.has_more ? " Load more jobs to include the rest of the queue." : ""}</div>`}</div>
      ${(jobsPaged ? jobsCursor : S.jobs?.next_after_id) ? `<button class="btn" id="load-jobs" type="button">Load more jobs</button>` : ""}
      <p class="meta">Showing ${jobs.length} matching jobs from ${all.length} loaded records. All changes stay in each job’s history.</p>
    </section>`;
  }

  // ------------------------------------------------------------ today

  function needsYou() {
    const questions = S.decisions.open;
    const approvals = S.plans.filter((p) => p.review_state === "reviewed");
    return { questions, approvals, total: questions.length + approvals.length };
  }

  // --- ticker strip -------------------------------------------------------------
  // Prices come from the watcher, which runs every five minutes through the session.
  // They are never live, so the age goes on screen in words and the motion stops when
  // the numbers stop being current. See the note in app.css.
  const STALE_AFTER_S = 15 * 60;

  // Same rule the hub applies server-side: a timestamp without a zone is not a
  // timestamp. Date.parse would happily read it in the viewer's own zone instead.
  function zonedMs(value) {
    if (typeof value !== "string") return null;
    if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim())) return null;
    const ms = Date.parse(value.trim().replace(" ", "T"));
    return Number.isFinite(ms) ? ms : null;
  }

  function sinceWords(seconds) {
    if (seconds === null) return "at an unrecorded time";
    if (seconds < 90) return "under a minute ago";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return mins + " min ago";
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? hrs + " hr ago" : Math.round(hrs / 24) + " days ago";
  }

  function compactAge(seconds) {
    if (seconds === null) return "no time";
    if (seconds < 60) return seconds + "s";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return mins + "m";
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? hrs + "h" : Math.round(hrs / 24) + "d";
  }

  // Every price carries its own age, always. These four symbols do not refresh together:
  // a crypto snapshot can be twenty minutes behind while an equity is seconds old, so a
  // single age for the whole strip would be wrong for most of it in both directions.
  function tickItem(q) {
    const sym = `<span class="tick-sym">${esc(q.symbol)}</span>`;
    if (!q.available || q.price === null || q.price === undefined) {
      return `<span class="tick">${sym}<span class="tick-none">no price this scan</span></span><span class="tick-sep"></span>`;
    }
    const ms = zonedMs(q.at);
    const age = ms === null ? null : Math.max(0, Math.round((Date.now() - ms) / 1000));
    const old = age === null || age > STALE_AFTER_S;
    const price = Math.abs(q.price) < 1 ? q.price.toFixed(4) : q.price.toFixed(2);
    const c = q.change_pct;
    const dir = c === null || c === undefined ? "flat" : c > 0 ? "up" : c < 0 ? "down" : "flat";
    const glyph = dir === "up" ? "\u25B2" : dir === "down" ? "\u25BC" : "\u2013";
    const chg = c === null || c === undefined ? "" :
      `<span class="tick-chg ${dir}">${glyph} ${Math.abs(c).toFixed(2)}%</span>`;
    return `<span class="tick ${old ? "is-old" : ""}">${sym}<span class="tick-px">${esc(price)}</span>${chg}` +
           `<span class="tick-age">${esc(compactAge(age))}</span></span><span class="tick-sep"></span>`;
  }

  function ticker() {
    const v = S.radar;
    const rows = (v && v.quotes) || [];
    if (!rows.length) return "";

    const readable = rows.filter((q) => q.available && q.price !== null && q.price !== undefined);
    const ages = readable.map((q) => zonedMs(q.at)).filter((ms) => ms !== null)
      .map((ms) => Math.max(0, Math.round((Date.now() - ms) / 1000)));
    const freshest = ages.length ? Math.min(...ages) : null;
    const closed = v.market && v.market.is_open === false;
    // The strip only stops when nothing on it is current. One stale symbol greys out on
    // its own; it does not freeze the whole row, and a fresh symbol never covers for it.
    const allOld = !readable.length || !ages.length || Math.min(...ages) > STALE_AFTER_S;
    const stale = closed || allOld;

    const items = rows.map(tickItem).join("");
    // Doubled so the loop meets itself. The copy is aria-hidden, so a screen reader
    // reads each price once.
    const track = `<div class="ticker-track">${items}<span aria-hidden="true">${items}</span></div>`;

    const lagging = readable.filter((q) => {
      const ms = zonedMs(q.at);
      return ms === null || (Date.now() - ms) / 1000 > STALE_AFTER_S;
    }).map((q) => q.symbol);
    const missing = rows.filter((q) => !q.available).map((q) => q.symbol);

    const bits = [`<span>Each price shows its own age. From the watcher's last scan, not a live feed.</span>`];
    if (closed) bits.push(`<span class="warn">Market closed, so these are the last prices of the session.</span>`);
    else if (allOld) bits.push(`<span class="warn">Nothing here is recent. Treat the whole strip as history.</span>`);
    else if (freshest !== null) bits.push(`<span class="age">Newest ${esc(sinceWords(freshest))}</span>`);
    if (lagging.length) bits.push(`<span class="warn">Behind by more than ${Math.round(STALE_AFTER_S / 60)} min: ${esc(lagging.join(", "))}.</span>`);
    if (missing.length) bits.push(`<span class="warn">No price this scan for ${esc(missing.join(", "))}.</span>`);

    return `<section class="section" aria-label="Prices from the last scan">
      <div class="ticker ${stale ? "is-stale" : ""}">${track}</div>
      <p class="ticker-meta">${bits.join("")}</p>
    </section>`;
  }

  function driftline() {
    if (!S.connections.length) {
      return `<div class="section"><div class="empty">No AI is connected yet. Open the AIs tab to connect Claude, ChatGPT or Grok.</div></div>`;
    }
    const width = Math.max(300, Math.min(680, view.clientWidth || 360));
    const pad = 34;
    const usable = width - pad * 2;
    const mid = 44;
    let d = `M 0 ${mid}`;
    for (let x = 0; x <= width; x += 8) d += ` L ${x} ${(mid + Math.sin(x / 26) * 5 + Math.sin(x / 71) * 3).toFixed(1)}`;
    const seen = S.connections.filter((c) => c.last_seen).map((c) => {
      const mins = Math.max(0, (S.server_time - c.last_seen) / 60000);
      return { ...c, mins, x: pad + usable * (1 - Math.min(mins, 60) / 60) };
    }).sort((a, b) => a.x - b.x);
    // Nudge markers apart so two AIs that checked in together stay readable.
    for (let i = 1; i < seen.length; i++) if (seen[i].x - seen[i - 1].x < 64) seen[i].x = Math.min(width - pad, seen[i - 1].x + 64);
    for (let i = seen.length - 2; i >= 0; i--) if (seen[i + 1].x - seen[i].x < 64) seen[i].x = Math.max(pad, seen[i + 1].x - 64);
    const initials = seen.map((c) => c.agent_name.slice(0, 1).toUpperCase());
    const marks = seen.map((c) => {
      // Claude and ChatGPT share a first letter, so a clash gets two letters.
      const first = c.agent_name.slice(0, 1).toUpperCase();
      const short = initials.filter((i) => i === first).length > 1 ? first + c.agent_name.slice(1, 2).toLowerCase() : first;
      const label = c.mins < 1 ? "now" : c.mins >= 60 ? "over 1 hr" : `${Math.round(c.mins)} min`;
      // The outer group places the marker; the inner one carries the one-time entrance motion.
      return `<g transform="translate(${c.x.toFixed(1)} ${mid})"><g class="who">
        <circle r="15" fill="${colorFor(c.agent_id)}"></circle>
        <text>${esc(short)}</text>
        <text class="tag" y="31">${esc(c.agent_name)}</text>
        <text class="tag" y="46" fill-opacity="0.7">${label}</text>
      </g></g>`;
    }).join("");
    const waiting = S.connections.filter((c) => !c.last_seen).map((c) => c.agent_name);
    const key = waiting.length ? `${waiting.join(" and ")} ${waiting.length === 1 ? "is" : "are"} connected but ${waiting.length === 1 ? "has" : "have"} not checked in yet.` : "";
    return `<div class="driftline" aria-label="When each AI last checked in">
      <svg width="${width}" height="96" viewBox="0 0 ${width} 96" role="img" aria-label="${esc(seen.map((c) => `${c.agent_name} ${ago(c.last_seen)}`).join(", ") || "No AI has checked in yet")}">
        <path class="wave" d="${d}"></path>
        <text class="tick" x="${pad - 22}" y="14">an hour ago</text>
        <text class="tick" x="${width - pad - 12}" y="14">now</text>
        ${marks}
      </svg>
    </div>
    <p class="driftline-key">When each AI last checked in. They look about once an hour, or when you ask them. ${esc(key)}</p>`;
  }

  function slipFor(q) {
    const options = (q.options || []).map((o) => `<button type="button" class="btn small" data-answer="${q.id}" data-text="${esc(o)}">${esc(o)}</button>`).join("");
    return `<article class="slip">
      <p class="from">${esc(q.author_name)} asks, ${esc(ago(q.created_at))}</p>
      <h3>${esc(q.question)}</h3>
      ${q.context ? `<p class="context">${esc(q.context)}</p>` : ""}
      ${options ? `<div class="answers">${options}</div>` : ""}
      <form data-answer-form="${q.id}">
        <input type="text" name="answer" placeholder="${options ? "Or type your own answer" : "Type your answer"}" aria-label="Your answer" maxlength="2000">
        <button class="btn small primary" type="submit">Answer</button>
      </form>
    </article>`;
  }

  function approvalSlip(p) {
    return `<article class="slip">
      <p class="from">${esc(p.author_name)} wrote this plan and ${esc(p.reviewed_by || "another AI")} reviewed it</p>
      <h3>Approve the plan to buy ${esc(p.symbol)}?</h3>
      <p class="context">Buy at or below ${esc(price(p.entry_price))}, sell at ${esc(price(p.target_price))}, get out at ${esc(price(p.stop_price))}. Size ${esc(money(p.size_dollars) ?? "not set")}.</p>
      <div class="answers">
        <button type="button" class="btn small" data-goto-plan="${esc(p.id)}">Read the whole plan</button>
      </div>
    </article>`;
  }

  function coverageTag(c) {
    if (c === "confirmed") return `<span class="tagline good">Stop in place</span>`;
    if (c === "partial") return `<span class="tagline warn">Partly covered</span>`;
    if (c === "none") return `<span class="tagline bad">No stop</span>`;
    return `<span class="tagline unknown">Stop not known</span>`;
  }

  function ledger() {
    const b = S.board;
    const s = b.snapshot;
    if (!s) {
      return `<div class="empty">No account numbers yet. They appear here when an AI reports a ${term("snapshot")} of the account.</div>`;
    }
    const val = (n, cls = "") => (n === null || n === undefined ? `<span class="value none">Not reported</span>` : `<span class="value ${cls}">${esc(money(n))}</span>`);
    const dayCls = s.day_change === null ? "" : s.day_change < 0 ? "down" : s.day_change > 0 ? "up" : "";
    const positions = s.positions === null
      ? `<div class="row"><span class="label">${term("position", "Positions")}</span><span class="value none">Not reported</span><span class="note">The AI did not check what you hold this time.</span></div>`
      : `<div class="row"><span class="label">${term("position", "Positions")}</span><span class="value">${s.positions.length} of ${b.rules.max_positions}</span>
          <span class="note">${s.positions.length ? "What you own right now, and whether each one has a stop." : "You own nothing right now. It is all cash."}</span></div>` +
        s.positions.map((p) => `<div class="row"><span class="label">${esc(p.symbol)} <span class="quiet num">${esc(String(+p.quantity.toFixed(6)))} sh</span></span>
          <span class="value">${p.market_value !== null ? esc(money(p.market_value)) : ""} ${coverageTag(p.coverage)}</span>
          <span class="note">${p.average_cost !== null ? `Bought at an average of ${esc(price(p.average_cost))} a share.` : ""}</span></div>`).join("");
    const orders = s.open_orders === null
      ? ""
      : s.open_orders.length
        ? s.open_orders.map((o) => `<div class="row"><span class="label">${o.side === "buy" ? "Buy" : "Sell"} ${esc(o.symbol)} <span class="quiet">${esc(o.type.replace(/_/g, " "))}</span></span>
            <span class="value num">${esc(String(+o.quantity.toFixed(6)))} sh ${o.stop_price !== null ? "at " + esc(price(o.stop_price)) : o.limit_price !== null ? "at " + esc(price(o.limit_price)) : ""}</span>
            <span class="note">Waiting at the broker${o.status ? `. Broker says: ${esc(o.status)}` : ""}.</span></div>`).join("")
        : `<div class="row"><span class="label">Orders waiting</span><span class="value">None</span><span class="note">Nothing is waiting to buy or sell at the broker.</span></div>`;
    return `<p class="stamp">Reported by ${esc(s.reported_by)} from ${esc(s.source)}, ${esc(s.age_words)} ago${s.completeness !== "complete" ? ". Not everything was checked" : ""}.</p>
      ${s.stale ? `<p class="banner">These numbers are ${term("stale", "out of date")}. Ask an AI to check the account for a fresh reading.</p>` : ""}
      <div class="ledger">
        <div class="row"><span class="label">${term("total value", "Total value")}</span>${val(s.total_value)}<span class="note">Cash plus what your shares are worth.</span></div>
        <div class="row"><span class="label">${term("cash", "Cash")}</span>${val(s.cash)}<span class="note">What you can spend on a new trade.</span></div>
        <div class="row"><span class="label">${term("buying power", "Buying power")}</span>${val(s.buying_power)}<span class="note">${s.buying_power_exceeds_cash ? "Higher than cash. That needs a look." : "Should match cash, since this account cannot borrow."}</span></div>
        <div class="row"><span class="label">${term("today", "Today")}</span>${val(s.day_change, dayCls)}<span class="note">Up or down on the day when the AI checked. Your ${term("daily stop")} is ${esc(money(b.rules.daily_trigger))}.</span></div>
        ${positions}
        ${orders}
      </div>
      ${s.note ? `<p class="stamp">Note from ${esc(s.reported_by)}: ${esc(s.note)}</p>` : ""}`;
  }

  function newsRow(item) {
    const at = zonedMs(item.published_at);
    const seconds = at === null ? null : Math.max(0, Math.floor((S.server_time - at) / 1000));
    return `<article class="news-item"><div><b>${esc((item.symbols || []).join(", "))}</b>
      <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">${esc(item.headline)}</a></div>
      <p><span class="age" data-news-at="${esc(item.published_at)}">${esc(sinceWords(seconds))}</span> · ${esc(item.source)}</p></article>`;
  }

  function renderToday() {
    const need = needsYou();
    const stops = S.board.exceptions.filter((e) => e.level === "stop");
    const warns = S.board.exceptions.filter((e) => e.level !== "stop");
    const s = S.board.snapshot;
    const r = S.board.rules;
    const amount = s && s.total_value !== null && s.total_value !== undefined
      ? `<div class="amt num">${esc(money(s.total_value))}</div>`
      : `<div class="amt none">No account numbers yet</div>`;
    const age = s
      ? `<div class="v2-age ${s.stale ? "" : "fresh"}">${esc(s.age_words)} old, reported by ${esc(s.reported_by)}</div>`
      : `<div class="v2-age">Nothing reported yet</div>`;
    const money2 = (n, dim) => (n === null || n === undefined
      ? `<b class="dim">not reported</b>` : `<b class="num${dim ? " dim" : ""}">${esc(money(n))}</b>`);

    const hero = `<section class="v2-hero">
      <div class="cap">Account value</div>
      ${amount}
      ${age}
      <div class="v2-split">
        <div><span>Cash</span>${s ? money2(s.cash) : `<b class="dim">–</b>`}</div>
        <div><span>Today</span>${s ? money2(s.day_change) : `<b class="dim">–</b>`}</div>
        <div><span>Slots free</span><b class="num">${r.slots_left} of ${r.max_positions}</b></div>
      </div>
    </section>`;

    // One headline, coloured by whether anything is actually wrong. The five separate
    // warning lines that used to sit here are behind the count now; nothing is lost,
    // but the screen answers its question before it lists its caveats.
    const flagCount = S.board.exceptions.length;
    const alsoFlagged = flagCount ? ` ${count(flagCount, "thing", "things")} also flagged below.` : "";
    // Seconds since the last scan, but only when it has been long enough to count
    // as stopped. null the rest of the time, so the all-clear is unaffected.
    const stopClock = scanClock(S.server_time || Date.now(), S.radar?.generated_at, S.radar?.market?.is_open);
    const scanStopped = stopClock.state === "late" ? stopClock.since : null;

    const alert = stops.length
      ? `<section class="v2-alert"><div class="ic">!</div><div>
           <h3>Stop and look</h3><p>${esc(stops[0].text)}</p>
           <button type="button" class="v2-more" data-tab-link="rules">See your rules</button></div></section>`
      : need.total
        // A waiting decision outranks a flag count. Saying "nothing needs you" above a
        // question card was the hub contradicting itself on the one line Casey reads first.
        ? `<section class="v2-alert"><div class="ic">?</div><div>
             <h3>${count(need.total, "thing", "things")} waiting on you</h3>
             <p>${need.questions.length ? "A question needs your answer." : ""}${need.approvals.length ? ` ${count(need.approvals.length, "plan", "plans")} reviewed and waiting for your approval.` : ""}${alsoFlagged}</p>
           </div></section>`
        : flagCount
          ? `<section class="v2-alert"><div class="ic">!</div><div>
               <h3>${count(flagCount, "thing", "things")} flagged</h3>
               <p>${esc(warns[0].text)}</p>
</div></section>`
          : scanStopped
            // The all-clear used to be given while the scanner had been dead for two
            // days. Nothing was flagged, because a stopped watcher raises no flags:
            // that is what stopped means. The first line Casey reads should not say
            // calm while the instrument feeding this page is not running.
            ? `<section class="v2-alert"><div class="ic">!</div><div>
                 <h3>The scanner has stopped</h3>
                 <p>Nothing has been scanned for ${esc(longSince(scanStopped))}. The hub is working; the watcher that feeds it is not, so the market numbers below are from then.</p></div></section>`
            : `<section class="v2-alert calm"><div class="ic">✓</div><div>
               <h3>Nothing needs you</h3>
               <p>No order can be placed from this hub, and no trading engine is running.</p></div></section>`;

    const held = s && s.positions && s.positions.length
      ? `<section class="v2-card"><h2>What you hold</h2>
          ${s.positions.map((p, i) => `<div class="v2-hold">
            <div class="v2-chip c${(i % 3) + 1}">${esc(p.symbol.slice(0, 4))}</div>
            <div class="nm"><b>${esc(p.symbol)}</b><span class="num">${esc(String(+p.quantity.toFixed(6)))} held</span></div>
            <div class="rt">${p.market_value !== null ? `<b class="num">${esc(money(p.market_value))}</b>` : `<b class="dim">–</b>`}
              ${coverageTag(p.coverage)}</div>
          </div>`).join("")}
        </section>`
      : "";

    // Meters, because a number with a bar beside it reads faster than a sentence.
    const spent = r.max_positions ? (r.max_positions - r.slots_left) / r.max_positions : 0;
    const rules = `<section class="v2-card"><h2>Your rules</h2>
      <p class="sub">Version ${r.version}. ${esc(r.instruments)}.</p>
      <div class="v2-meter"><div class="lab"><span>Position slots used</span><b>${r.max_positions - r.slots_left} of ${r.max_positions}</b></div>
        <div class="track"><svg viewBox="0 0 100 9" preserveAspectRatio="none" height="9" aria-hidden="true"><rect x="0" y="0" width="${(spent * 100).toFixed(1)}" height="9" rx="4" fill="${spent >= 1 ? "#ff8f6b" : "#3ee6b0"}"/></svg></div></div>
      <div class="v2-meter"><div class="lab"><span>Most per trade</span><b class="num">${esc(money(r.max_per_trade))}</b></div></div>
      <div class="v2-meter"><div class="lab"><span>Stop new orders once down</span><b class="num">${esc(money(r.daily_trigger))}</b></div></div>
      <p class="v2-fineprint">${esc(r.daily_trigger_words || "Checked when an AI reports a snapshot or before an order. It is not watched continuously, so it limits new orders but does not cap a day's loss.")}</p>
    </section>`;

    const needed = need.total
      ? `<section class="v2-card"><h2>Needs you</h2>${need.questions.map(slipFor).join("")}${need.approvals.map(approvalSlip).join("")}</section>`
      : "";

    const feed = S.news;
    const rows = (feed?.items || []).slice(0, 5).map(newsRow).join("");
    const newsPanel = !feed
      ? `<section class="v2-card news-strip" data-news-state="unavailable"><h2>News touching your radar</h2><p class="sub">No watcher news has reached the Hub yet. This is unavailable, not a quiet market.</p></section>`
      : feed.stale
        ? `<section class="v2-card news-strip" data-news-state="stale"><h2>News touching your radar</h2><p class="banner">The feed last reached the Hub ${esc(String(feed.age_minutes))} minutes ago. These headlines may be old.</p>${rows}</section>`
        : !feed.items.length
          ? `<section class="v2-card news-strip" data-news-state="empty"><h2>News touching your radar</h2><p class="sub">The watcher checked, but no tagged headline matched a radar, watchlist or held symbol.</p></section>`
          : `<section class="v2-card news-strip" data-news-state="fresh"><h2>News touching your radar</h2><p class="sub">What was reported, without a bullish or bearish label. Feed checked ${esc(feed.age_minutes < 1 ? "under a minute ago" : `${feed.age_minutes} min ago`)}.</p>${rows}</section>`;

    // The flag lines are short summaries. The full records, with their source, date and
    // account-match caveats, live in historical_details and historical_notices. The
    // first version of this screen read neither, which quietly dropped the only place
    // those caveats appeared. Collapsed behind a tap is fine. Discarded is not.
    const hist = [...(S.board.historical_details || []), ...(S.board.historical_notices || [])];
    const flagList = flagCount || hist.length
      ? `<details class="v2-card" id="v2-flaglist"><summary>${flagCount ? `Show all ${flagCount} flags and earlier reports` : "Show earlier protection reports"}</summary>
          ${S.board.exceptions.map((f) => `<div class="v2-hold"><div class="nm"><span>${esc(f.text)}</span></div></div>`).join("")}
          ${hist.length ? `<h2 class="v2-sub">What the earlier reports actually said</h2>
            ${hist.map((h) => `<div class="v2-hold"><div class="nm"><span>${esc(h.text)}</span></div></div>`).join("")}` : ""}
        </details>`
      : "";

    // Order is a judgement about what Casey needs first on a phone. Stop flags,
    // then anything waiting on him, then his money. The workspace deck is good
    // and it is still an orientation panel: it was sitting above the account
    // total, so the balance had six screens of scrolling in front of it.
    return `<div class="v2 command-view">
      ${alert}
      ${needed}
      ${flagList}
      ${hero}
      ${ticker()}
      ${newsPanel}
      ${filingsPanel()}
      ${workspaceDeck()}
      ${activityDeck()}
      ${held}
      ${labFindings()}
      ${labCard()}
      ${rules}
      ${driftline()}
    </div>`;
  }

  // Casey asked for the hub to have moving parts. The one thing here that can
  // honestly move every second is the clock: how long since the watcher last
  // scanned, and how long until it scans again. That is the hub's own time, not
  // market data, so it can tick without pretending a price is updating. Prices
  // and candidates still only change when a scan arrives.
  const SCAN_EVERY_MS = 5 * 60 * 1000;

  /** Exported shape for checks: where we are in the scan cycle, from the clock alone. */
  // Three missed cycles. One late scan is weather; three is a stopped scanner.
  const LATE_AFTER_MS = 3 * SCAN_EVERY_MS;

  // The scanner's own schedule: cron "*/5 8-22 * * 1-5" in the watcher, so weekdays
  // 08:00 to 22:59 UTC. Outside that window no scan is due, and calling the scanner
  // stopped then is a false alarm. The first version of this notice would have cried
  // wolf every night and all weekend, which is how a warning gets ignored.
  function scanExpected(now) {
    const d = new Date(now);
    const day = d.getUTCDay(), hour = d.getUTCHours();
    return day >= 1 && day <= 5 && hour >= 8 && hour <= 22;
  }

  function scanClock(now, generatedAt, isOpen) {
    const at = typeof generatedAt === "string" && /[Tt ].*(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(generatedAt)
      ? Date.parse(generatedAt) : NaN;
    if (!Number.isFinite(at) || at > now) return { state: "unknown", since: null, until: null, fraction: 0 };
    const since = Math.floor((now - at) / 1000);
    // isOpen is what the LAST scan saw, not what is true now. A Saturday scan still
    // says closed on Monday, so trusting it hides a stopped scanner behind a calm
    // "market closed". Only treat closed as closed while the scan is still recent.
    if (isOpen === false && since * 1000 < LATE_AFTER_MS) return { state: "closed", since, until: null, fraction: 0 };
    const until = Math.ceil((at + SCAN_EVERY_MS - now) / 1000);
    // A scan can land a little late, which is not worth shouting about. A scan that
    // has not landed in three cycles has stopped, and saying "due now" then implies
    // one is coming. The scanner was dead for two days reading exactly that.
    if (since * 1000 >= LATE_AFTER_MS) {
      // Overdue only counts against the hours the scanner actually runs.
      return { state: scanExpected(now) ? "late" : "idle", since, until: null, fraction: 1 };
    }
    if (until <= 0) return { state: "due", since, until: 0, fraction: 1 };
    return { state: "waiting", since, until, fraction: Math.min(1, (now - at) / SCAN_EVERY_MS) };
  }

  function countdownWords(clock) {
    if (clock.state === "unknown") return "Scan time unavailable";
    if (clock.state === "closed") return "Next scan when the market reopens";
    if (clock.state === "due") return "Next scan due now";
    if (clock.state === "late") return "No scan arriving. The scanner has stopped.";
    if (clock.state === "idle") return "Outside scanning hours. The next run is due when the market reopens.";
    const m = Math.floor(clock.until / 60), s = clock.until % 60;
    return `Next scan in ${m}:${String(s).padStart(2, "0")}`;
  }

  function longSince(seconds) {
    if (!Number.isFinite(seconds)) return "an unknown time";
    const m = Math.floor(seconds / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return `${d} ${d === 1 ? "day" : "days"}`;
    if (h >= 1) return `${h} ${h === 1 ? "hour" : "hours"}`;
    return `${Math.max(1, m)} ${m === 1 ? "minute" : "minutes"}`;
  }

  function elapsedWords(clock) {
    if (clock.since === null) return "Last scan time unavailable";
    if (clock.since < 60) return `Last scan ${clock.since}s ago`;
    const m = Math.floor(clock.since / 60);
    return m < 60 ? `Last scan ${m} min ago` : `Last scan ${Math.floor(m / 60)} hr ago`;
  }

  // Patch the text in place once a second. A full re-render every second would
  // fight anything Casey is typing and churn the whole page for two numbers.
  function tickScanClock() {
    const host = view.querySelector("[data-scan-clock]");
    if (!host || !S) return;
    const clock = scanClock(Date.now(), S.radar?.generated_at, S.radar?.market?.is_open);
    const next = host.querySelector("[data-scan-next]");
    const elapsed = host.querySelector("[data-scan-elapsed]");
    const ring = host.querySelector("[data-scan-ring]");
    if (next) next.textContent = countdownWords(clock);
    if (elapsed) elapsed.textContent = elapsedWords(clock);
    if (ring) {
      ring.style.setProperty("--fraction", clock.fraction.toFixed(4));
      ring.dataset.scanRing = clock.state;
    }
    view.querySelectorAll("[data-news-at]").forEach((node) => {
      const at = zonedMs(node.dataset.newsAt);
      node.textContent = sinceWords(at === null ? null : Math.max(0, Math.floor((Date.now() - at) / 1000)));
    });
  }

  // A view of reported work, never an invented heartbeat or simulated market feed.
  function workspaceDeck() {
    const counts = S.jobs?.counts || {};
    const v = S.radar;
    const now = S.server_time;
    const dated = typeof v?.generated_at === "string" && /[Tt ].*(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(v.generated_at);
    const scanAt = dated ? Date.parse(v.generated_at) : NaN;
    const age = Number.isFinite(scanAt) && scanAt <= now ? Math.floor((now - scanAt) / 60000) : null;
    // No frozen age anywhere on this card. It used to print one in the header
    // at render time while the live clock below kept counting, so the same
    // card showed "Scan 1 min ago" and "Last scan 3 min ago" two inches apart.
    // One age, and it is the one that stays true. Found by looking at it.
    const knownCount = Number.isInteger(v?.candidate_count) && v.candidate_count >= 0;
    const recent = age !== null && age <= 15 && !v?.stale;
    const closed = v?.market?.is_open === false;
    const clock = scanClock(now, v?.generated_at, v?.market?.is_open);
    // A stopped scanner outranks everything the last scan reported, including its
    // own "market closed". Saturday's scan said closed, so on Monday this card read
    // "Market closed at last scan" while the market was open and nothing was running.
    const dead = clock.state === "late";
    const phase = !v ? "Waiting for a scan"
      : dead ? `Nothing for ${esc(longSince(clock.since))}`
      : closed ? "Market closed at last scan"
      : !recent ? "Scan needs a refresh"
      : v.market?.is_open === true ? "Market open at last scan" : "Session not reported";
    // dead and !recent are the same 15-minute threshold, so they share one state
    // name. What changed is the wording, not the number of states.
    const status = !v ? "missing" : dead || !recent ? "late" : closed ? "closed" : "reported";
    const n = knownCount ? v.candidate_count : null;
    const title = dead ? "The scanner has stopped"
      : n === null ? "Radar awaiting data"
      : n === 0 ? "No names qualified"
      : `${n} ${n === 1 ? "name" : "names"} qualified`;
    const detail = dead
      ? `Nothing has been scanned for ${longSince(clock.since)}, so every number here is from then and none of it describes the market now.`
      : n === 0 ? "The last scan found no setups that passed the filters."
      : n === null ? "Open Research to check the scanner’s last report."
      : "Open the scan to see the setups and headline timing.";
    const lanes = [
      ["ready", "Ready to build", "Work accepted by its owner", "blue"],
      ["in_progress", "In progress", "Work reported as underway", "mint"],
      ["review", "Independent review", "Evidence awaiting another pair of eyes", "amber"],
      ["blocked", "Blocked", "A dependency needs attention", "coral"],
    ];
    return `<section class="command-deck" aria-labelledby="deck-title">
      <div class="deck-heading"><span class="deck-eyebrow">THE DRIFTLINE WORKSPACE</span><span class="deck-stamp">State synced ${esc(new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span></div>
      <div class="deck-intro"><div><h1 id="deck-title">See the work.<br><em>Find the next move.</em></h1><p>Research, decisions and your AI team. <br>One place to see what is moving forward.</p></div>
        <div class="deck-emblem" aria-hidden="true"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="orbit orbit-three"></span><span class="orbit-core">D<span>DRIFTLINE</span></span></div></div>
      <div class="deck-lanes" aria-label="Reported project work">${lanes.map(([key,label,note,color]) => `<button type="button" class="deck-lane ${color}" data-deck-job-status="${key}"><span class="lane-count">${esc(counts[key] || 0)}</span><span class="lane-label">${label}</span><small>${note}</small><span class="lane-link">View jobs</span></button>`).join("")}</div>
      <p class="deck-footnote">${esc(counts.done || 0)} jobs completed at this sync. Agents work during their sessions; a job status does not mean someone is online.</p>
      <button type="button" class="deck-radar" data-tab-link="research" data-scan-state="${status}">
        <span class="radar-symbol" data-scan-ring="${esc(clock.state)}" aria-hidden="true"><i></i></span><span class="radar-copy"><span class="deck-eyebrow">MARKET RADAR</span><strong>${esc(title)}</strong><span>${esc(detail)}</span></span>
        <span class="radar-state">${esc(phase)}<small>View research</small></span>
      </button>
      <p class="deck-footnote scan-clock" data-scan-clock>
        <span data-scan-elapsed>${esc(elapsedWords(clock))}</span>
        <span class="scan-dot" aria-hidden="true"></span>
        <span data-scan-next>${esc(countdownWords(clock))}</span>
        <span class="scan-note">The clock is live. The prices are not: they change only when a scan lands.</span>
      </p>
    </section>`;
  }

  function activityDeck() {
    const age = at => {
      if (!Number.isFinite(at) || at > S.server_time) return "time unavailable";
      const minutes = Math.floor((S.server_time - at) / 60000);
      return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
    };
    const peopleHere = (S.connections || []).filter(c => c.agent_name).slice(0, 6);
    const tasks = (S.jobs?.tasks || []).filter(t => ["in_progress", "review", "blocked"].includes(t.status))
      .sort((a,b) => (b.updated_at || 0) - (a.updated_at || 0)).slice(0, 3);
    const messages = (S.chat?.messages || []).filter(m => m.author_kind !== "system").slice(-3).reverse();
    return `<div class="activity-grid">
      <section class="activity-card"><div class="activity-heading"><div><p class="deck-eyebrow">PEOPLE & PROGRESS</p><h2>Your team’s desk</h2></div><button class="deck-text-link" type="button" data-tab-link="ais">Team</button></div>
        <div class="desk-people">${peopleHere.length ? peopleHere.map(c => `<button type="button" data-tab-link="ais" class="desk-person"><span class="desk-avatar">${esc(c.agent_name.slice(0, 2))}</span><strong>${esc(c.agent_name)}</strong><small>Seen ${esc(age(c.last_seen))}</small></button>`).join("") : `<p class="sub">No team check-ins reported yet.</p>`}</div>
        <div class="desk-work">${tasks.length ? tasks.map(t => `<button type="button" class="desk-task" data-deck-job-status="${esc(t.status)}"><span class="status-pill ${esc(t.status)}">${esc(({in_progress:"In progress",review:"Review",blocked:"Blocked"})[t.status])}</span><strong>${esc(t.title)}</strong><small>${esc(t.owner_id || "Unassigned")} · updated ${esc(age(t.updated_at))}</small></button>`).join("") : `<p class="sub">No work is currently reported as in progress, blocked or awaiting review.</p>`}</div>
      </section>
      <section class="activity-card"><div class="activity-heading"><div><p class="deck-eyebrow">THE CONVERSATION</p><h2>Latest at the Hub</h2></div><button class="deck-text-link" type="button" data-tab-link="chat">Open chat</button></div>
        <div class="desk-messages">${messages.length ? messages.map(m => `<button class="desk-message" type="button" data-tab-link="chat"><span><strong>${esc(m.from || m.author_name || "Team")}</strong><small>${esc(age(m.at || m.created_at))}</small></span><p>${esc(String(m.body || "").replace(/\*\*|#{1,6}\s/g, "").slice(0, 190))}${String(m.body || "").length > 190 ? "…" : ""}</p><small>Read full message</small></button>`).join("") : `<p class="sub">The conversation will appear here after the next workspace sync.</p>`}</div>
      </section>
    </div>`;
  }

  // The lab, as a picture on the front page rather than a paragraph three taps away.
  // What the lab found, as pictures rather than a table three taps away. Casey
  // asked to understand what he is looking at, so each figure answers one
  // question and says what it rests on. Palette checked with the dataviz
  // validator against this surface rather than chosen by eye: #27a07d, #c86448
  // and #4487c9 pass the lightness band, chroma floor, normal-vision separation
  // and contrast. Colour-blind separation lands at 7.4, inside the band that is
  // only legal with secondary encoding, so every segment carries its own label.
  const LAB_GOOD = "#27a07d", LAB_BAD = "#c86448", LAB_FLAT = "#4487c9";

  // The EDGAR watcher. Casey asked how to catch a news move; the honest finding is
  // that by the time a headline reaches a person, most of the move has happened.
  // So this card leads with the measurement rather than the filings: three clocks
  // say how late he actually is, and after a couple of weeks that number decides
  // whether chasing speed is worth any more work. The filings are the evidence
  // underneath it, not the product.
  function filingsPanel() {
    const f = S.filings;
    if (!f) return "";
    const when = (ms) => sinceWords(Math.max(0, Math.round(((S.server_time || Date.now()) - ms) / 1000)));

    const secs = (n) => n === null ? null
      : n < 90 ? `${n} seconds`
      : n < 5400 ? `${Math.round(n / 60)} minutes`
      : `${(n / 3600).toFixed(1)} hours`;

    const pickup = secs(f.median_pickup_seconds);
    const mine = secs(f.median_to_casey_seconds);

    const measure = f.measured_on === 0
      ? `<p class="sub">Nothing measured yet. Each filing records when the SEC accepted it, when this hub saw it, and when you first opened it.</p>`
      : `<div class="filing-clocks">
          <div><span>SEC to this hub</span><strong>${esc(pickup ?? "not measured")}</strong><small>median over ${esc(String(f.measured_on))} filing${f.measured_on === 1 ? "" : "s"}</small></div>
          <div><span>SEC to you seeing it</span><strong>${esc(mine ?? "not yet")}</strong><small>${mine ? "median, your actual delay" : "measured once you open some"}</small></div>
        </div>
        ${mine ? `<p class="sub">That second number is the one that matters. On 17 November, Nvidia moved from $150.45 to $153.07 in the six minutes before CNBC published the statement behind it. Compare it against your own delay before putting more work into speed.</p>` : ""}`;

    let state = "", rows = "";
    if (!f.checked_at) {
      state = `<p class="sub">The watcher has not run yet. It is scheduled every five minutes on weekdays while US markets are open.</p>`;
    } else if (!f.ok) {
      state = `<p class="filing-problem"><b>The last check failed.</b> ${esc(f.error || "No reason was recorded.")}</p>`;
    } else if (!f.items.length) {
      state = `<p class="sub">Checked ${esc(when(f.checked_at))} and nothing has been filed that carries an item code worth showing. That is the usual answer.</p>`;
    } else {
      rows = `<ul class="filing-list">${f.items.map((x) => `<li>
        <div class="filing-top"><b>${esc(x.company)}</b><span>${esc(when(x.accepted_at))}</span></div>
        <p>${esc(describeFilingItems(x.items))}</p>
        <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Read the filing at the SEC</a>
      </li>`).join("")}</ul>`;
      state = `<p class="sub">Checked ${esc(when(f.checked_at))}. These are filings, not advice, and a filing often follows a move rather than causing one.</p>`;
    }

    return `<section class="v2-card filings" data-filings-state="${esc(!f.checked_at ? "never" : !f.ok ? "failed" : f.items.length ? "filings" : "quiet")}">
      <h2>Company filings, and how late you are</h2>
      ${measure}
      ${state}
      ${rows}
    </section>`;
  }

  // Item codes in plain words. Mirrors src/edgar.ts; an unknown code is shown
  // rather than dropped, because a code we do not recognise is still a fact.
  const FILING_ITEMS = {
    "1.01": "entered a material agreement",
    "1.03": "bankruptcy or receivership",
    "2.01": "completed an acquisition or disposal",
    "2.02": "reported results",
    "4.01": "changed accountants",
    "4.02": "said earlier financials cannot be relied on",
    "5.02": "an officer or director left or was appointed",
    "7.01": "regulation FD disclosure",
    "8.01": "other events the company chose to report",
  };

  function describeFilingItems(items) {
    const parts = String(items || "").split(",").map((c) => c.trim()).filter(Boolean);
    if (!parts.length) return "No item codes were listed.";
    return parts.map((c) => FILING_ITEMS[c] ? `${c}, ${FILING_ITEMS[c]}` : `${c}, a code we do not recognise`).join(". ") + ".";
  }

  function labFindings() {
    const r = S.research;
    const ended = (r?.how_trades_ended || []).filter((x) => Number.isFinite(x.share_pct) && x.share_pct > 0);
    const sweep = (r?.stop_sweep || []).filter((x) => Number.isFinite(x.avg_dollars) && Number.isFinite(x.avg_r));
    if (!ended.length && !sweep.length) return "";
    const total = ended.reduce((n, x) => n + (x.trades || 0), 0);

    // One stacked bar, because the question is "what share of trades did what".
    // Colour by what the ending means, so it reads the same if the order changes.
    const tone = (label) => /target/i.test(label) ? LAB_GOOD : /stop/i.test(label) ? LAB_BAD : LAB_FLAT;
    const share = (v) => `${Number(v).toFixed(1)}%`;
    let x = 0;
    const endedFig = !ended.length ? "" : `
      <figure class="lab-fig">
        <figcaption>How ${esc(total.toLocaleString())} trades ended</figcaption>
        <svg viewBox="0 0 300 26" height="26" preserveAspectRatio="none" role="img"
             aria-label="${esc(ended.map((e) => `${e.label}, ${e.share_pct}%`).join(". "))}">
          ${ended.map((e) => {
            const w = Math.max(1.5, (e.share_pct / 100) * 300);
            const seg = `<rect x="${x.toFixed(2)}" y="0" width="${Math.max(0.5, w - 2).toFixed(2)}" height="26" rx="4" fill="${tone(e.label)}"/>`;
            x += w;
            return seg;
          }).join("")}
        </svg>
        <ul class="lab-key">
          ${ended.map((e) => `<li><i class="lab-chip" data-tone="${/target/i.test(e.label) ? "good" : /stop/i.test(e.label) ? "bad" : "flat"}"></i>
            <b>${esc(share(e.share_pct))}</b> ${esc(e.label.toLowerCase())}<small>${esc((e.trades || 0).toLocaleString())} trades</small></li>`).join("")}
        </ul>
      </figure>`;

    // Two charts, not one with two scales. They share an axis of stop widths and
    // disagree on purpose: that disagreement is the finding. A single chart with
    // two y-scales would let either line be drawn to tell either story.
    const bars = (rows, value, tint, fmt) => {
      const span = Math.max(...rows.map((d) => Math.abs(value(d))), 1e-9);
      return rows.map((d, i) => {
        const h = Math.max(2, (Math.abs(value(d)) / span) * 46);
        // Baseline at 62 with 16 of headroom, so the tallest bar's own label
        // still has somewhere to sit. It used to clip off the top of the box.
        return `<g><rect x="${i * 42 + 6}" y="${(62 - h).toFixed(1)}" width="30" height="${h.toFixed(1)}" rx="3" fill="${tint(d)}"/>
          <text x="${i * 42 + 21}" y="76" text-anchor="middle" class="lab-tick">${esc(d.stop_pct)}%</text>
          <text x="${i * 42 + 21}" y="${(58 - h).toFixed(1)}" text-anchor="middle" class="lab-val">${esc(fmt(value(d)))}</text></g>`;
      }).join("");
    };
    const sweepFig = !sweep.length ? "" : `
      <figure class="lab-fig lab-sweep">
        <figcaption>Does a wider stop help? The two usual measures disagree.</figcaption>
        <div class="lab-pair">
          <div><p class="lab-sub">Judged by R, the trader's usual measure</p>
            <svg viewBox="0 0 ${sweep.length * 42} 80" height="86" role="img"
                 aria-label="Average R by stop width: ${esc(sweep.map((d) => `${d.stop_pct}% stop, ${d.avg_r}R`).join("; "))}">
              ${bars(sweep, (d) => d.avg_r, () => LAB_FLAT, (v) => v.toFixed(2))}
            </svg>
            <p class="lab-note">Shorter is better here, so a wider stop looks like a fix.</p></div>
          <div><p class="lab-sub">Judged by money, on the same $40 trade</p>
            <svg viewBox="0 0 ${sweep.length * 42} 80" height="86" role="img"
                 aria-label="Average dollars by stop width: ${esc(sweep.map((d) => `${d.stop_pct}% stop, ${d.avg_dollars} dollars`).join("; "))}">
              ${bars(sweep, (d) => d.avg_dollars, () => LAB_BAD, (v) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`)}
            </svg>
            <p class="lab-note">Every bar is a loss, and the widest stops lose most.</p></div>
        </div>
        <p class="lab-why">R is measured in units of your stop, so widening the stop shrinks every R whether or not a trade went better. The money is the same trades, same size, no such trick.</p>
      </figure>`;

    return `<section class="v2-card lab-findings"><h2>What the lab found</h2>
      <p class="sub">From Casey's own backtest${r?.window?.start ? `, ${esc(r.window.start)} to ${esc(r.window.end)}` : ""}. Modelled costs included. What the rules would have done, not what any trade will do.</p>
      ${endedFig}${sweepFig}
      <button type="button" class="v2-more" data-tab-link="research">Open the whole lab</button>
    </section>`;
  }

  function labCard() {
    const sw = S.research?.swing;
    const rows = (sw?.strategies || []).filter((x) => Number.isFinite(x.cagr));
    const problem = sw?.problem || S.research?.problem || S.research?.unavailable;
    const problemHtml = problem ? `<p class="banner">${esc(problem)}</p>` : "";
    if (!rows.length) {
      const empty = !S.research ? "Lab results have not been read yet."
        : sw ? "No readable strategy results were published."
        : "The slow lab is unavailable; this does not mean it found no opportunities.";
      return `<section class="v2-card"><h2>Your slow lab</h2>${problemHtml || `<p class="sub">${empty}</p>`}
        <button type="button" class="v2-more" data-tab-link="research">See the whole lab</button></section>`;
    }
    const sorted = rows.slice().sort((a, b) => b.cagr - a.cagr);
    const pick = sorted.length === 1 ? [sorted[0]] : [sorted[0], sorted[sorted.length - 1]];
    const span = Math.max(...pick.map((x) => Math.abs(x.cagr)), 1);
    const drawdown = (x) => Number.isFinite(x.worst_drawdown) ? `${x.worst_drawdown}%` : "not reported";
    const sig = (sw.signals?.sleeves || []).map((x) => {
      const reading = x.signal === "HOLD" ? "hold" : x.signal === "CASH" ? "cash" : "unknown";
      return `<span><i class="${x.signal === "HOLD" ? "v2-dot-up" : "v2-dot-flat"}"></i>${esc(x.symbol)} reads ${reading}; as of ${esc(x.as_of || "unknown date")}</span>`;
    }).join("");
    // Each strategy has its own start date, so one blanket "twenty years" over the card
    // was wrong for most of the rows. Each row now carries the window it actually covers.
    // Fetch age and signal observation date are separate facts; a fresh fetch is not a fresh signal.
    const readMs = typeof S.research?.read_at === "number" ? S.research.read_at
      : typeof S.research?.read_at === "string" ? Date.parse(S.research.read_at) : NaN;
    const read = Number.isFinite(readMs) ? sinceWords(Math.max(0, Math.round((Date.now() - readMs) / 1000))) : null;
    return `<section class="v2-card"><h2>Your slow lab</h2>
      ${problemHtml}<p class="sub">${rows.length === 1 ? "One strategy result" : `The best and the worst of ${rows.length} strategies`} over the reported historical windows, with assumed costs.</p>
      ${pick.map((x) => {
        // The bar used to be one tall figure above the rows. CSS height:auto stretched
        // it past its own viewBox and the bars drifted away from the names they belonged
        // to. Each row now carries its own bar, at a height CSS cannot stretch.
        const w = (Math.abs(x.cagr) / span) * 170, neg = x.cagr < 0;
        return `<div class="v2-strat">
          <div class="hd"><b>${esc(x.name)}</b>
            <span class="num ${neg ? "v2-neg" : "v2-pos"}">${x.cagr > 0 ? "+" : ""}${esc(String(x.cagr))}% a year</span></div>
          <svg class="v2-dbar" viewBox="0 0 360 12" preserveAspectRatio="none" role="img"
               aria-label="${esc(`${x.name}: ${x.cagr}% a year, worst fall ${drawdown(x)}`)}">
            <rect x="0" y="0" width="360" height="12" rx="6" fill="#06202d"/>
            <rect x="${(neg ? 180 - w : 180).toFixed(1)}" y="2" width="${Math.max(2, w).toFixed(1)}" height="8" rx="4"
                  fill="${neg ? "#e0603c" : "#19b98c"}"/>
            <rect x="179.6" y="0" width="0.8" height="12" fill="#2d6076"/>
          </svg>
          <span class="ft">worst fall ${drawdown(x)} along the way, tested from ${esc(x.since || "unknown date")}</span>
        </div>`;
      }).join("")}
      ${sig ? `<div class="v2-legend">${sig}</div><p class="v2-fineprint">Signal source: <a href="https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/swing_signal.json">dated rule readings (raw data)</a>.</p>` : ""}
      <p class="v2-fineprint">Source: <a href="https://raw.githubusercontent.com/caseycbar-sudo/Alpaca-breakout-watcher/main/docs/data/swing_lab.json">swing lab backtest (raw data)</a>; ${read ? `fetched ${esc(read)}` : "fetch time unknown"}. These are modelled past results with assumed costs, not a prediction and not permission to trade. Cash and hold readings describe the rule on its stated observation date, not a current broker position.</p>
      <button type="button" class="v2-more" data-tab-link="research">See the whole lab</button>
    </section>`;
  }

  function messageHtml(m) {
    const kind = m.author_kind === "owner" ? "owner" : m.author_kind === "system" ? "system" : esc(m.author_id);
    if (m.author_kind === "system") return `<div class="msg system" data-id="${m.id}"><div class="body md">${markdown(m.body)}</div></div>`;
    const long = m.body.length > 700 && !expandedMessages.has(m.id);
    return `<div class="msg ${kind}" data-id="${m.id}">
      <div class="who"><b>${esc(m.author_kind === "owner" ? "You" : m.author_name)}</b><span>${esc(clock(m.created_at))}</span></div>
      <div class="body md${long ? " clipped" : ""}">${markdown(m.body)}</div>
      ${long ? `<button type="button" class="linkish more" data-expand="${m.id}">Show the whole message</button>` : ""}
      ${m.author_id === "hub-assistant" ? `<p class="caption">Automatic reply from the hub's helper, not from Claude, ChatGPT or Grok. It only reads what is in the hub, and it can be wrong.</p>` : ""}
    </div>`;
  }

  function allMessages() {
    const byId = new Map();
    for (const m of olderChat) byId.set(m.id, m);
    for (const m of S.chat.messages) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  function renderChat() {
    const msgs = allMessages();
    const older = olderChat.length ? hasOlder : S.chat.has_older;
    return `<div class="chat" id="chat-list">
        ${older ? `<p class="center"><button type="button" class="btn small" id="load-older">Show earlier messages</button></p>` : ""}
        ${msgs.length ? msgs.map(messageHtml).join("") : `<div class="empty">No messages yet. Say hello, and your AIs will see it the next time they check in.</div>`}
      </div>
      <div class="composer"><form id="composer">
        <textarea name="body" rows="1" placeholder="Message your AIs" aria-label="Message your AIs" maxlength="8000"></textarea>
        <button class="btn primary" type="submit">Send</button>
      </form></div>`;
  }

  async function markChatSeen() {
    const msgs = S.chat.messages;
    if (!msgs.length || !S.unread) return;
    try {
      await api("/api/chat/seen", { id: msgs[msgs.length - 1].id });
      S.unread = 0;
      badges();
    } catch { /* tried; the next poll will retry */ }
  }

  // ----------------------------------------------------------- trades

  function orderWords(p) {
    const prot = { pending: "Its stop is not in place yet.", confirmed: "A stop is in place.", degraded: "Its stop only covers part of it.", unknown: "Whether it has a stop is not known.", not_applicable: "" }[p.protection_state] || "";
    switch (p.order_state) {
      case "none": return p.review_state === "authorized" ? "You approved this. No order has been recorded yet." : "Nothing has been bought.";
      case "submission_pending": return "An order is being sent to the broker.";
      case "working": return "The order is waiting at the broker for its price.";
      case "partially_filled": return `Part of the order has gone through. ${prot}`;
      case "filled": return `Bought${p.fill_price !== null ? " at " + price(p.fill_price) : ""}. ${prot}`;
      case "rejected": return "The broker rejected the order. Nothing was bought.";
      case "expired": return "The order expired without filling. Nothing was bought.";
      case "canceled": return "The order was cancelled.";
      case "unknown": return "The order's status is not known and has to be checked with the broker.";
      case "closed": return `Finished. ${p.result_dollars !== null ? "Result: " + money(p.result_dollars) + "." : ""}`;
      default: return "";
    }
  }

  function planHtml(p, ctx) {
    const at = ctx?.now ?? Date.now();
    const snap = ctx?.snapshot ?? null;
    const reviewed = ["reviewed", "authorized"].includes(p.review_state);
    const objected = p.review_state === "objected";
    const approved = p.review_state === "authorized";
    const declined = p.review_state === "declined";
    const history = openHistories.has(p.id) ? historyCache[p.id] : null;
    const canDecline = !declined && p.order_state === "none";
    const lapsed = planLapsed(p, at, snap);
    return `<article class="plan${lapsed ? " lapsed" : ""}" id="plan-${esc(p.id)}"${lapsed ? ' data-plan-lapsed="true"' : ""}>
      <div class="plan-head"><h3>${esc(p.symbol)}</h3>${lapsed ? `<span class="plan-tag">Out of date</span>` : ""}<span class="id">Plan ${esc(p.id)} by ${esc(p.author_name)}, ${esc(ago(p.created_at))}</span></div>
      ${lapsedNote(lapsed, p.symbol)}
      <p class="see">${esc(p.what_we_see)}</p>
      ${p.why ? `<p class="see quiet">${esc(p.why)}</p>` : ""}
      <dl>
        <div><dt>Buy at or below</dt><dd>${esc(price(p.entry_price))}</dd></div>
        <div><dt>Sell at</dt><dd>${esc(price(p.target_price))}</dd></div>
        <div><dt>Get out at</dt><dd>${esc(price(p.stop_price))}</dd></div>
        <div><dt>Amount</dt><dd>${esc(money(p.size_dollars) ?? "Not set")}</dd></div>
        <div><dt>Likely loss if wrong</dt><dd>${esc(money(p.est_loss_at_stop) ?? "Not set")}</dd></div>
        <div><dt>Good until</dt><dd>${esc(shortDate(p.good_until))}</dd></div>
      </dl>
      ${p.wrong_if ? `<p class="state"><strong>Wrong if:</strong> ${esc(p.wrong_if)}</p>` : ""}
      <ol class="steps">
        <li class="done">Written by ${esc(p.author_name)}</li>
        <li class="${reviewed ? "done" : objected ? "no" : ""}">${reviewed ? `Reviewed by ${esc(p.reviewed_by || "an AI")}` : objected ? `Objection from ${esc(p.reviewed_by || "an AI")}` : "Waiting for a review"}</li>
        <li class="${approved ? "done" : declined ? "no" : ""}">${approved ? "Approved by you" : declined ? "Declined by you" : "Your approval"}</li>
      </ol>
      ${objected && p.review_comment ? `<p class="banner">Objection: ${esc(p.review_comment)}</p>` : ""}
      ${reviewed && p.review_comment ? `<p class="state quiet">Reviewer's note: ${esc(p.review_comment)}</p>` : ""}
      <p class="state">${esc(orderWords(p))}</p>
      ${p.lesson ? `<p class="state"><strong>What we learned:</strong> ${esc(p.lesson)}</p>` : ""}
      <div class="actions">
        ${p.review_state === "reviewed" && p.record_kind !== "existing_holding"
          ? `<button type="button" class="btn primary" data-plan-act="approve" data-plan="${esc(p.id)}">Approve this plan</button>` : ""}
        ${canDecline ? `<button type="button" class="btn${p.review_state === "reviewed" ? "" : " small"}" data-plan-act="decline" data-plan="${esc(p.id)}">Decline</button>` : ""}
        <button type="button" class="btn small" data-plan-history="${esc(p.id)}">${openHistories.has(p.id) ? "Hide the history" : "Show the history"}</button>
        ${p.record_kind === "existing_holding"
          ? `<button type="button" class="btn small" data-plan-kind="trade_plan" data-plan="${esc(p.id)}">This is not something I already own</button>`
          : `<button type="button" class="btn small" data-plan-kind="existing_holding" data-plan="${esc(p.id)}">I already own this, it was not ordered here</button>`}
      </div>
      ${history ? `<ul class="history">${history.map((h) => `<li><strong>${esc(h.actor_name)}</strong> ${esc(h.action)} <span class="quiet">${esc(clock(h.at))}</span></li>`).join("")}</ul>` : ""}
    </article>`;
  }

  // A plan carries its own expiry date and nothing ever read it, so Grok's two
  // stop proposals still looked live days after their good_until and after the
  // positions they protected had been sold. Both facts are already known here;
  // neither needs a background job rewriting records to surface them. Display
  // only: nothing below writes anything.
  function planLapsed(p, now, snapshot) {
    if (p.order_state === "closed" || p.review_state === "declined") return null;

    // good_until is a plain YYYY-MM-DD day, and a plan is good through the end of
    // that day, so compare against the day after it rather than its midnight.
    let expired = null;
    const d = typeof p.good_until === "string" ? p.good_until.trim() : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const end = Date.parse(`${d}T23:59:59Z`);
      if (Number.isFinite(end) && now > end) expired = d;
    }

    // A plan that protects or exits a position is moot once the position is gone.
    // Only say so from a snapshot that actually listed positions: a snapshot with
    // no positions array has not reported, which is not the same as reporting none.
    let orphaned = false;
    const held = Array.isArray(snapshot?.positions) ? snapshot.positions : null;
    // != null, not !== null: these arrive undefined as often as null, and a strict
    // check called every plan with no stop an orphan.
    if (held && p.symbol && (p.stop_price != null || p.target_price != null)) {
      orphaned = !held.some((h) => String(h?.symbol || "").toUpperCase() === String(p.symbol).toUpperCase());
    }
    if (!expired && !orphaned) return null;
    return { expired, orphaned, snapshot_age: snapshot?.observed_at ?? null };
  }

  function lapsedNote(l, symbol) {
    if (!l) return "";
    const bits = [];
    if (l.expired) bits.push(`its own good-until date passed on ${esc(shortDate(l.expired))}`);
    if (l.orphaned) bits.push(`the last account snapshot shows no ${esc(symbol)} position for it to act on`);
    return `<p class="plan-lapsed"><b>Out of date.</b> This plan is still here because nothing deletes a record,
      but ${bits.join(", and ")}. Read it as history, not as something to act on.</p>`;
  }

  function renderTrades() {
    return `<section class="section"><h2>Trade plans</h2>
      <p class="sub">Every idea is written down here before anything is bought. A second AI ${term("review", "reviews")} it, then you ${term("approve", "approve")} or decline. Declined and unfilled plans stay, because they are part of the learning.</p>
      ${S.plans.length ? S.plans.map((p) => planHtml(p, { now: S.server_time || Date.now(), snapshot: S.board?.snapshot })).join("") : `<div class="empty">No trade plans yet. When one of your AIs has an idea, it shows up here first, with the price to buy at, where to take profit, and where to get out.</div>`}
    </section>`;
  }

  // ------------------------------------------------------------ rules

  function renderRules() {
    const r = S.rules.current;
    return `<section class="section"><h2>Your rules, version ${r.version}</h2>
      <p class="sub">Only you can change these. The hub refuses any plan bigger than your per-trade amount.</p>
      <ul class="rule-lines">
        <li><strong>${esc(money(r.max_per_trade))}</strong> at most in any one trade<span class="note">Keeps any single mistake small.</span></li>
        <li><strong>${esc(money(r.daily_trigger))}</strong> down on the day means no new orders until tomorrow<span class="note">Your ${term("daily stop")}. Checked when an AI looks, not every second.</span></li>
        <li><strong>${r.max_positions}</strong> positions at most at one time<span class="note">Counts everything you already hold.</span></li>
        <li><strong>${esc(r.instruments)}</strong><span class="note">What may be traded.</span></li>
        ${r.notes ? `<li>${esc(r.notes)}</li>` : ""}
      </ul>
      <details class="gloss"><summary>Change the rules</summary>
        <form id="rules-form" class="formgrid">
          <div class="pair">
            <div><label for="r-max">Most per trade ($)</label><input id="r-max" name="max_per_trade" type="number" inputmode="decimal" min="1" step="1" value="${r.max_per_trade}" required></div>
            <div><label for="r-day">Daily stop ($)</label><input id="r-day" name="daily_trigger" type="number" inputmode="decimal" min="1" step="1" value="${r.daily_trigger}" required></div>
          </div>
          <div class="pair">
            <div><label for="r-pos">Positions at once</label><input id="r-pos" name="max_positions" type="number" inputmode="numeric" min="1" step="1" value="${r.max_positions}" required></div>
            <div><label for="r-inst">What may be traded</label><input id="r-inst" name="instruments" type="text" value="${esc(r.instruments)}" required></div>
          </div>
          <div><label for="r-notes">Other rules, in your words</label><textarea id="r-notes" name="notes" rows="3">${esc(r.notes || "")}</textarea></div>
          <div><label for="r-why">Why are you changing them?</label><input id="r-why" name="change_note" type="text" placeholder="One line, kept in the history" required></div>
          <div><button class="btn primary" type="submit">Save as version ${r.version + 1}</button></div>
        </form>
      </details>
    </section>
    <section class="section"><h2>How the rules have changed</h2>
      <ul class="history-list">${S.rules.history.map((h) => `<li><strong>Version ${h.version}</strong> <span class="quiet">${esc(clock(h.created_at))}</span><br>${esc(h.change_note)}</li>`).join("")}</ul>
    </section>
    <section class="section"><h2>Words used here</h2>
      ${Object.values(GLOSSARY).map(([title, text]) => `<details class="gloss"><summary>${esc(title)}</summary><p>${esc(text)}</p></details>`).join("")}
    </section>`;
  }

  // -------------------------------------------------------------- AIs

  function renderAis() {
    const list = S.connections.length
      ? S.connections.map((c) => `<article class="ai">
          <h3>${esc(c.agent_name)}</h3>
          <ul>${c.may.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
          <p class="meta">Connected ${esc(ago(c.connected_at))}. ${c.last_seen ? `Last here ${esc(ago(c.last_seen))}${c.last_action ? `, when it ${esc(c.last_action)}` : ""}.` : "Has not checked in yet."}</p>
          <div class="actions"><button type="button" class="btn small danger" data-disconnect="${esc(c.grant_id)}" data-name="${esc(c.agent_name)}">Disconnect ${esc(c.agent_name)}</button></div>
        </article>`).join("")
      : `<div class="empty">No AI is connected yet. Follow the steps below for each one.</div>`;
    return `<section class="section"><h2>Connected AIs</h2>
      <p class="sub">Each AI has its own pass that you approved. None of them can place an order, change your rules, or approve a plan.</p>
      ${list}
    </section>
    <section class="section"><h2>Instant replies</h2>
      <p class="sub">Your three AIs only look here about once an hour. These two helpers act the moment you send a message.</p>
      ${helpersHtml()}
    </section>
    <section class="section"><h2>Connect an AI</h2>
      <ol class="plain">
        <li>Copy the ${term("connector")} address below.</li>
        <li>In Claude, ChatGPT or Grok, open the settings for connectors and add a custom one. Paste the address.</li>
        <li>Press Connect. This hub opens and asks you which AI it is and what it may do.</li>
        <li>Then tell that AI: “Check the Driftline hub.”</li>
      </ol>
      <div class="address">
        <input type="text" readonly value="${esc(S.connector_address)}" id="connector-address" aria-label="Connector address">
        <button type="button" class="btn" id="copy-address">Copy</button>
      </div>
    </section>
    <section class="section"><h2>Your sign-in and your records</h2>
      <details class="gloss"><summary>Change your passphrase</summary>
        <form id="pass-form" class="formgrid">
          <div><label for="p-cur">Current passphrase</label><input id="p-cur" name="current" type="password" autocomplete="current-password" required></div>
          <div><label for="p-new">New passphrase</label><input id="p-new" name="next" type="password" autocomplete="new-password" minlength="12" required></div>
          <div><button class="btn primary" type="submit">Change passphrase</button></div>
        </form>
      </details>
      <p class="stamp"><a class="btn small" href="/api/export">Download everything as a file</a></p>
      <p class="stamp">The download holds the chat, plans, rules, questions and account readings. It has no passwords in it.</p>
      <form method="post" action="/sign-out" class="stamp"><button class="btn small" type="submit">Sign out</button></form>
    </section>`;
  }

  function helpersHtml() {
    const h = S.helpers;
    const a = h.assistant;
    const assistant = !a.available
      ? `<p class="meta">Not available on this hub yet.</p>`
      : `<div class="switchline"><span class="state">${a.enabled ? "On" : "Off"}</span>
          <button type="button" class="btn small${a.enabled ? "" : " primary"}" data-helper="assistant" data-to="${a.enabled ? "off" : "on"}">${a.enabled ? "Turn off" : "Turn on"}</button></div>
         <p class="meta">${a.replies_today} of ${a.daily_cap} replies used today. Free, inside Cloudflare's daily allowance.</p>`;
    const w = h.wake;
    const any = w.claude.set_up || w.grok.set_up;
    const line = (name, x) => !x.set_up
      ? `<li>${name}: not set up yet</li>`
      : `<li>${name}: ready. ${x.today} of ${w.daily_cap} used today${x.last_at ? `, last one ${esc(ago(x.last_at))}` : ""}${x.last_problem ? `. Problem: ${esc(x.last_problem)}` : ""}</li>`;
    const wake = `<ul>${line("Claude", w.claude)}${line("Grok", w.grok)}<li>ChatGPT: its maker offers no wake-up, so it checks on its own schedule</li></ul>` + (!any
      ? `<p class="meta">Each one needs a private key from that AI's app, saved in Cloudflare. Claude can walk you through it.</p>`
      : `<div class="switchline"><span class="state">${w.enabled ? "On" : "Off"}</span>
          <button type="button" class="btn small${w.enabled ? "" : " primary"}" data-helper="wake" data-to="${w.enabled ? "off" : "on"}">${w.enabled ? "Turn off" : "Turn on"}</button></div>
         <p class="meta">At most one wake-up every 10 minutes for each AI.</p>`);
    return `<article class="ai">
        <h3>Hub assistant</h3>
        <ul>
          <li>Answers you in seconds, from what is already in the hub</li>
          <li>Tells you what is waiting on you and on each AI</li>
          <li>Never suggests a trade, reviews a plan, or speaks for your three AIs</li>
        </ul>
        <p class="meta">It is a smaller, separate AI (${esc(a.model_words)}). It is not Claude, ChatGPT or Grok, and it can be wrong.</p>
        ${assistant}
      </article>
      <article class="ai">
        <h3>Wake-ups</h3>
        <p class="meta">When you post, the hub asks these AIs to come and read it right away. A reply usually takes a minute or two.</p>
        ${wake}
      </article>`;
  }

  // ----------------------------------------------------------- render

  // ------------------------------------------------------- research
  function runLine(label, r, note) {
    if (!r || r.trades === null) return "";
    const pf = r.profit_factor === null ? "" : ` Profit factor ${r.profit_factor}, so it ${r.profit_factor >= 1 ? "made back more than it lost" : "lost more than it made"}.`;
    return `<article class="ai">
      <h3>${esc(label)}</h3>
      <p class="meta">${esc(note)}</p>
      <ul>
        <li><strong>${r.trades}</strong> trades</li>
        <li><strong>${r.win_rate === null ? "unknown" : r.win_rate + "%"}</strong> of them won</li>
        <li>Average result <strong>${r.avg_r === null ? "unknown" : r.avg_r + "R"}</strong>${r.avg_r !== null && r.avg_r < 0 ? " (a loss)" : ""}</li>
      </ul>
      <p class="meta">R means one unit of what the trade risked. Minus 0.5R on a trade risking $10 is a $5 loss.${pf}</p>
    </article>`;
  }

  function patternBlock(title, lead, list) {
    if (!list || !list.length) return `<section class="section"><h2>${esc(title)}</h2><p class="sub">${esc(lead)}</p><p class="meta">The lab did not list any this run.</p></section>`;
    return `<section class="section"><h2>${esc(title)}</h2><p class="sub">${esc(lead)}</p>
      ${list.map((p) => `<article class="ai"><h3>${esc(p.pattern)}</h3>
        <p class="meta">Earlier validation sample: ${p.trades_checked == null ? "trade count not reported. " : `${esc(p.trades_checked)} trades. `}${p.avg_r == null ? "" : `Average ${esc(p.avg_r)}R. `}${p.win_rate == null ? "" : `${esc(p.win_rate)}% won.`}</p>
        <p class="banner">Unseen result: ${esc(p.unseen_result || "not reported")}. ${p.unseen?.trades == null ? "Unseen trade count not reported." : `${esc(p.unseen.trades)} trades.`}${p.unseen?.avg_r == null ? "" : ` Average ${esc(p.unseen.avg_r)}R.`}${p.unseen?.win_rate == null ? "" : ` ${esc(p.unseen.win_rate)}% won.`}</p>
        ${p.evidence ? `<p class="meta">Producer's selection evidence label: ${esc(p.evidence)}. This does not establish performance on unseen data.</p>` : ""}</article>`).join("")}
    </section>`;
  }

  function labTable(rows, cols) {
    return `<div class="plan-table"><table><thead><tr>${cols.map((c) => `<th>${esc(c[0])}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(c[1](r))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const rTxt = (v) => (v === null || v === undefined ? "–" : `${v}R`);
  const pcTxt = (v) => (v === null || v === undefined ? "–" : `${v}%`);

  function radarPanel() {
    const v = S.radar;
    if (!v) return `<section class="section"><h2>Live radar</h2>
      <p class="sub">What your watcher last saw in the market.</p>
      <p class="meta">No scan has reached the hub yet.</p></section>`;
    const when = v.age_minutes === null ? "at an unknown time" : v.age_minutes < 1 ? "less than a minute ago" : v.age_minutes === 1 ? "a minute ago" : v.age_minutes < 90 ? `${v.age_minutes} minutes ago` : `${Math.round(v.age_minutes / 60)} hours ago`;
    const phase = v.market?.phase ? esc(v.market.phase) : "unknown";
    const head = v.candidate_count === 0
      ? `Nothing passed your gates in that scan. That is the usual answer, and it is the rules working rather than failing.`
      : `${v.candidate_count} ${v.candidate_count === 1 ? "name" : "names"} passed your gates in that scan.`;
    const cards = (v.candidates || []).map((c) => `<article class="ai">
        <h3>${esc(c.symbol)}${c.price === null ? "" : ` · ${price(c.price)}`}</h3>
        <p class="meta">${[c.stage, c.setup, c.confirmation].filter(Boolean).map(esc).join(" · ") || "No stage reported."}</p>
        <ul>
          ${c.breakout_level === null ? "" : `<li>Breakout level ${price(c.breakout_level)}${c.technical_stop === null ? "" : `, stop would sit near ${price(c.technical_stop)}`}</li>`}
          ${c.day_move_pct === null ? "" : `<li>Up ${c.day_move_pct}% on the day</li>`}
          ${c.relative_volume === null ? "" : `<li>${c.relative_volume}x its usual volume</li>`}
          ${c.spread_pct === null ? "" : `<li>Spread ${c.spread_pct}%</li>`}
          ${c.rsi === null ? "" : `<li>RSI ${c.rsi}</li>`}
        </ul>
        ${c.news?.headline ? `<p class="meta">Headline${c.news.published_at ? ` at ${esc(c.news.published_at)}` : ""}: ${c.news.url ? `<a href="${esc(c.news.url)}" rel="noopener noreferrer" target="_blank">${esc(c.news.headline)}</a>` : esc(c.news.headline)}</p>
          ${c.news.verdict ? `<p class="banner">${esc(c.news.basis || "The timing of this headline could not be checked.")}</p>` : ""}` : `<p class="meta">No headline found beside this one.</p>`}
        ${(c.checks?.risk_sources || []).length ? `<p class="banner">${c.checks.risk_sources.map(esc).join(" · ")}</p>` : ""}
      </article>`).join("");
    return `<section class="section"><h2>Live radar</h2>
        <p class="sub">What your watcher saw in the market, ${esc(when)}. Market was ${phase}.</p>
        <p class="lead">${head}</p>
        ${v.stale ? `<p class="banner">This scan is ${esc(when)}, so it is history rather than what is happening now.</p>` : ""}
        ${v.note ? `<p class="meta">${esc(v.note)}</p>` : ""}
        ${cards}
        ${(v.gates || []).length ? `<details><summary>The gates a name has to pass</summary>
          ${labTable(v.gates, [["Gate", (g) => g.label], ["Rule", (g) => g.rule || "–"]])}</details>` : ""}
        <p class="meta">Sources: ${[v.sources?.market_data && `market data ${v.sources.market_data}`, v.sources?.halts && `halts ${v.sources.halts}`, v.sources?.sec_edgar && `SEC ${v.sources.sec_edgar}`].filter(Boolean).map(esc).join(" · ") || "not reported"}. Arrived ${esc(v.arrived_via)}.</p>
      </section>`;
  }

  // --- charts ---------------------------------------------------------------
  // Two forms, chosen by what the data is for, not by what looks impressive.
  //
  // The lab trend is change-over-time for one measure, so: a line. The section it
  // sits in asks "has the answer been steady?", which a line answers at a glance and
  // a table of twenty rows does not.
  //
  // The strategy comparison is polarity, made money or lost it, so: diverging bars
  // around a zero line. Return and drawdown are both percentages but they are
  // different measures, and a second axis for the second one is the commonest way to
  // make a chart lie, so drawdown is a direct label rather than a second scale.
  //
  // Colour never carries a value on its own here. Every bar is labelled with its
  // signed number, and the table under each chart stays as the readable form. The
  // green/coral pair is the same one the ticker uses and was chosen with a
  // colourblind-separation check rather than by eye.
  const UP = "#6fd6ae", DOWN = "#e2896f", AXIS = "#3b5468", INK = "#9fb4c4";

  function trendChart(rows) {
    const pts = rows.filter((r) => typeof r.avg_r === "number");
    // One point is not a trend. Saying so is more useful than drawing a dot.
    if (pts.length < 3) return "";
    const W = 640, H = 150, L = 8, R = 54, T = 12, B = 22;
    const vals = pts.map((r) => r.avg_r);
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (hi === lo) { hi += 0.5; lo -= 0.5; }
    const pad = (hi - lo) * 0.12;
    lo -= pad; hi += pad;
    const x = (i) => L + (i * (W - L - R)) / Math.max(1, pts.length - 1);
    const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
    const zero = y(0);
    const line = pts.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(r.avg_r).toFixed(1)}`).join(" ");
    const area = `${line} L${x(pts.length - 1).toFixed(1)} ${zero.toFixed(1)} L${x(0).toFixed(1)} ${zero.toFixed(1)} Z`;
    const last = pts[pts.length - 1];
    const dots = pts.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r.avg_r).toFixed(1)}" r="9" fill="transparent"><title>${esc(r.at)}: ${r.avg_r}R over ${r.trades === null ? "an unknown number of" : r.trades} trades</title></circle>`).join("");
    return `<figure class="chart">
      <svg viewBox="0 0 ${W} ${H}" role="img" width="100%" height="${H}"
           aria-label="Average R per lab run across ${pts.length} runs. Latest ${last.avg_r} R. The table below has every value.">
        <defs><linearGradient id="trendfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="${UP}" stop-opacity=".30"/><stop offset="1" stop-color="${UP}" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#trendfill)"/>
        <line x1="${L}" x2="${W - R}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}" stroke="${AXIS}" stroke-width="1" stroke-dasharray="3 3"/>
        <text x="${W - R + 6}" y="${(zero + 4).toFixed(1)}" fill="${INK}" font-size="11">break even</text>
        <path d="${line}" fill="none" stroke="${UP}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last.avg_r).toFixed(1)}" r="4" fill="${UP}" stroke="#0d1a2b" stroke-width="2"/>
        <text x="${W - R + 6}" y="${(y(last.avg_r) + 4).toFixed(1)}" fill="${INK}" font-size="12" font-weight="600">${esc(String(last.avg_r))}R</text>
        ${dots}
      </svg>
      <figcaption>Average R per trade, one point per lab run, oldest on the left. Below the dashed line the rules lost money on that run.</figcaption>
    </figure>`;
  }

  // Drawn as SVG rather than positioned divs on purpose. The page sends
  // style-src 'self' with no unsafe-inline, so a style="width:42%" attribute is parsed
  // into the DOM and then ignored, which is how the first version of this chart drew
  // every bar as a 2px sliver. SVG geometry lives in presentation attributes, which the
  // policy does not touch. Loosening the CSP to let a chart position itself would be a
  // bad trade: that directive is a real defence, and this needed no exception.
  function strategyChart(rows) {
    // Every strategy, never a top slice. The table under this chart lists all of them,
    // and the row that matters most to Casey is the worst one: the lab's "current-style"
    // entry, named after how he actually trades, which lost essentially everything. It
    // ranks last by Sharpe, so a top-eight chart hid it completely while showing eight
    // winners. A chart of results that quietly drops the catastrophic result is not a
    // summary, it is a recommendation.
    //
    // Sorted by return here, because that is what the bars encode. The table keeps the
    // risk-adjusted order, so each view is internally consistent.
    const pts = rows.filter((s) => typeof s.cagr === "number").slice().sort((a, b) => b.cagr - a.cagr);
    if (pts.length < 2) return "";
    const span = Math.max(...pts.map((s) => Math.abs(s.cagr)), 1);
    const half = 50; // percent of the row width each arm may use
    return `<figure class="chart">
      <ul class="bars">${pts.map((s) => {
        const w = (Math.abs(s.cagr) / span) * half;
        const neg = s.cagr < 0;
        const dd = s.worst_drawdown === null ? "worst fall not reported" : `worst fall ${s.worst_drawdown}%`;
        return `<li>
          <span class="bar-name">${esc(s.name)}</span>
          <svg class="bar-rail" viewBox="0 0 360 14" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <rect x="0" y="0" width="360" height="14" rx="7" fill="#0b1726"/>
            <rect x="${(neg ? 180 - (w / half) * 180 : 180).toFixed(2)}" y="3" width="${Math.max(1.5, (w / half) * 180).toFixed(2)}" height="8" rx="2" fill="${neg ? DOWN : UP}"/>
            <rect x="179.6" y="0" width="0.8" height="14" fill="#3b5468"/>
          </svg>
          <span class="bar-val ${neg ? "neg" : "pos"}">${s.cagr > 0 ? "+" : ""}${esc(String(s.cagr))}%</span>
          <span class="bar-note">${esc(dd)}</span>
        </li>`;
      }).join("")}</ul>
      <figcaption>Every strategy the lab tested, best return first, measured from the zero line in the middle. The worst fall beside each one is the deepest drop it took along the way, which is the number that decides whether anyone could actually have held it. A high return with a near-total fall is not a strategy anyone survives.</figcaption>
    </figure>`;
  }

  function swingBlock(sw) {
    if (!sw) return "";
    const sig = sw.signals;
    const cards = (sig?.sleeves || []).map((x) => `<article class="ai">
        <h3>${esc(x.symbol)} · ${x.signal === "HOLD" ? "hold" : "cash"}</h3>
        <p class="meta">The rule: ${esc(x.rule || "a trend filter")}.</p>
        <ul>
          <li>Last close ${price(x.close)}</li>
          <li>Its average ${price(x.average)}</li>
          <li>${x.distance_pct === null ? "" : `${x.distance_pct > 0 ? "Above" : "Below"} it by ${Math.abs(x.distance_pct)}%`}</li>
        </ul>
        <p class="meta">${x.signal === "HOLD" ? "Above the line, so this rule would be holding it." : "Below the line, so this rule would be in cash."} Reading from ${esc(x.as_of || "an unknown date")}. This is what the rule says, not what to do.</p>
      </article>`).join("");
    return `<section class="section"><h2>Your second lab: slow strategies</h2>
        <p class="sub">Twenty years of daily bars with real costs, testing well-known slow strategies instead of intraday breakouts. This is the better-evidenced of your two labs.</p>
        ${sw.problem ? `<p class="banner">${esc(sw.problem)}</p>` : ""}
        ${cards ? `<p class="lead">Today's readings</p>${cards}` : ""}
        ${sw.strategies?.length ? `<p class="lead">What it found, best risk-adjusted first</p>
          ${strategyChart(sw.strategies)}
          ${labTable(sw.strategies, [["Strategy", (x) => x.name], ["Return a year", (x) => (x.cagr === null ? "–" : x.cagr + "%")], ["Worst fall", (x) => (x.worst_drawdown === null ? "–" : x.worst_drawdown + "%")], ["Sharpe", (x) => (x.sharpe === null ? "–" : x.sharpe)], ["Trades a year", (x) => (x.trades_per_year === null ? "–" : x.trades_per_year)]])}
          <p class="meta">Sharpe is return measured against how bumpy the ride was; higher is steadier for the same return. "Worst fall" is the deepest drop from a high point along the way, which is the part that actually makes people quit.</p>` : ""}
        <p class="meta">Backtests on past data. They say what a rule would have done, not what it will do. Nothing here places an order.</p>
      </section>`;
  }

  function renderResearch() {
    const r = S.research;
    const desk = globalThis.HubResearchDesk?.render({...S, policy: researchPolicy}, researchSymbol, researchCategory) || "";
    if (!r || r.unavailable) {
      return desk + radarPanel() + `<section class="section"><h2>Your breakout lab</h2>
        <p class="sub">The hub reads the results your watcher publishes, so every trade idea here can be checked against your own history.</p>
        <p class="banner">${esc(r?.unavailable || "Not read yet.")}</p>
        <div class="actions"><button type="button" class="btn" id="lab-refresh">Try again</button></div></section>`;
    }
    const age = r.age_days === null ? "" : r.age_days === 0 ? "today" : r.age_days === 1 ? "yesterday" : `${r.age_days} days ago`;
    return desk + radarPanel() + `<section class="section"><h2>Your breakout lab</h2>
        <p class="sub">What your own rules actually did, replayed over past market days. This is where a trade idea gets checked against evidence instead of opinion.</p>
        <p class="lead">${esc(r.headline)}</p>
        ${r.stale ? `<p class="banner">The lab last ran ${esc(age)}. These findings are getting old, so the market it studied may not be the one you are trading.</p>` : ""}
        <p class="meta">Lab run ${esc(age)}${r.window?.start ? `, covering ${esc(r.window.start)} to ${esc(r.window.end)}` : ""}${r.window?.trading_days ? ` (${r.window.trading_days} trading days)` : ""}.</p>
        <div class="actions"><button type="button" class="btn" id="lab-refresh">Read the lab again</button></div>
      </section>
      <section class="section"><h2>How the rules performed</h2>
        ${runLine("Taking every signal", r.every_signal, "The loose version: enter on anything that looks like a breakout.")}
        ${runLine("Only the strict setups", r.strict_rules, "The careful version: every gate has to pass before entering.")}
      </section>
      ${r.model?.verdict ? `<section class="section"><h2>Can it be predicted?</h2>
        <p class="sub">The lab also trains a model to guess which breakouts work.</p>
        <p class="lead">${esc(r.model.verdict)}</p></section>` : ""}
      ${r.what_moves_the_odds?.length ? `<section class="section"><h2>How trades went, split by condition</h2>
        <p class="sub">The lab split every trade by one condition and compared the two halves.</p>
        ${r.lookahead_warning ? `<p class="banner">${esc(r.lookahead_warning)}</p>` : ""}
        ${r.what_moves_the_odds.map((x) => `<article class="ai"><h3>${esc(x.label)}</h3>
          <p class="meta">${x.knowable_at_entry === false ? "⚠ Not known until after you are already in. Cannot be used to pick a trade." : "Known before you enter, so this one could be used as a filter."}</p>
          <ul><li>When it was true: <strong>${pcTxt(x.with_it.win_rate)}</strong> won, average ${rTxt(x.with_it.avg_r)} over ${x.with_it.trades} trades</li>
          <li>When it was not: <strong>${pcTxt(x.without_it.win_rate)}</strong> won, average ${rTxt(x.without_it.avg_r)} over ${x.without_it.trades} trades</li></ul>
          <p class="meta">Gap of ${rTxt(x.difference_r)} a trade.</p></article>`).join("")}
      </section>` : ""}
      ${r.best_times?.length ? `<section class="section"><h2>Time of day</h2>
        <p class="sub">Same rules, split by when the trade started.</p>
        ${labTable(r.best_times, [["When", (x) => x.bucket], ["Trades", (x) => x.trades], ["Won", (x) => pcTxt(x.win_rate)], ["Average", (x) => rTxt(x.avg_r)]])}
      </section>` : ""}
      ${r.day_shape?.trading_days ? `<section class="section"><h2>What a day looked like</h2>
        <p class="lead">${r.day_shape.green_days} days up, ${r.day_shape.red_days} down, out of ${r.day_shape.trading_days}. The average day came to ${rTxt(r.day_shape.average_day_r)}.</p>
        <p class="meta">Best day ${esc(r.day_shape.best_day?.date || "unknown")} at ${rTxt(r.day_shape.best_day?.total_r)} on ${r.day_shape.best_day?.trades ?? "?"} trades. Worst day ${esc(r.day_shape.worst_day?.date || "unknown")} at ${rTxt(r.day_shape.worst_day?.total_r)} on ${r.day_shape.worst_day?.trades ?? "?"} trades.</p>
        <p class="meta">This is the loose version taking every signal, which is why the totals are large next to your real position sizes.</p>
      </section>` : ""}
      ${r.how_trades_ended?.length ? `<section class="section"><h2>How trades ended</h2>
        ${labTable(r.how_trades_ended, [["Ending", (x) => x.label], ["Trades", (x) => x.trades], ["Share", (x) => pcTxt(x.share_pct)], ["Average", (x) => rTxt(x.avg_r)]])}
      </section>` : ""}
      ${r.target_sweep?.length ? `<section class="section"><h2>Where to put the target</h2>
        <p class="sub">The same trades replayed with different profit targets, to see which one the market actually paid.</p>
        ${labTable(r.target_sweep, [["Target", (x) => x.target_pct + "%"], ["Won", (x) => pcTxt(x.win_rate)], ["Hit target", (x) => pcTxt(x.target_hit_rate)], ["Average", (x) => rTxt(x.avg_r)]])}
      </section>` : ""}
      ${r.your_gates?.length ? `<section class="section"><h2>Do your entry gates earn their keep?</h2>
        <p class="sub">Each gate compared against the trades that failed it. If passing is no better than failing, the gate is not doing much.</p>
        ${labTable(r.your_gates, [["Gate", (x) => x.gate], ["Passed", (x) => `${rTxt(x.passed.avg_r)} (${x.passed.trades})`], ["Failed", (x) => `${rTxt(x.failed.avg_r)} (${x.failed.trades})`], ["Verdict", (x) => x.verdict || "–"]])}
      </section>` : ""}
      ${r.model_factors?.length ? `<section class="section"><h2>What the model leans on</h2>
        <p class="sub">The strongest things it uses to tell winners from losers.</p>
        <ul class="plain">${r.model_factors.map((f) => `<li>${esc(f.effect || f.factor)}</li>`).join("")}</ul>
      </section>` : ""}
      ${r.symbols?.length ? `<section class="section"><h2>Best behaved symbols</h2>
        <p class="sub">Of the ${r.symbols_studied ?? "studied"} it watched, these had at least 10 trades. A good average here is still a small sample, not a shopping list.</p>
        ${labTable(r.symbols, [["Symbol", (x) => x.symbol], ["Trades", (x) => x.trades], ["Won", (x) => pcTxt(x.win_rate)], ["Average", (x) => rTxt(x.avg_r)]])}
      </section>` : ""}
      ${r.trend?.length > 1 ? `<section class="section"><h2>Has the answer been steady?</h2>
        <p class="sub">Every lab run since it started keeping score. If the conclusion jumps around, no single run means much.</p>
        ${trendChart(r.trend)}
        ${labTable(r.trend.slice(-10).reverse(), [["Run", (x) => x.at], ["Trades", (x) => x.trades], ["Average", (x) => rTxt(x.avg_r)], ["Avoid list", (x) => x.avoid_count], ["Selected for checking", (x) => (x.promising.length ? x.promising.join(", ") : "nothing")]])}
      </section>` : ""}
      ${swingBlock(r.swing)}
      ${patternBlock("Patterns flagged as weak", "Selected using earlier samples. Read the unseen result separately; a label does not prove future performance.", r.stay_away_from)}
      ${patternBlock("Patterns selected for checking", "Looked promising in earlier samples. They may fail on unseen days; selection is not validation.", r.held_up)}
      <section class="section"><h2>Read this before you lean on it</h2>
        <p class="meta">${esc(r.caveat)}</p>
        ${r.assumptions?.entry ? `<p class="meta">Entry: ${esc(r.assumptions.entry)}. Exit: ${esc(r.assumptions.exit || "not stated")}. Every fill pays a modeled ${r.assumptions.spread_pct}% spread and ${r.assumptions.slippage_pct}% slippage, aiming at ${r.assumptions.reward_to_risk} times the risk.</p>` : ""}
        ${r.caveats?.length ? `<ul class="plain">${r.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        <p class="meta">Claude, ChatGPT and Grok can read all of this too, and are asked to quote it when they write or review a plan.</p>
      </section>`;
  }

  const RENDER = { jobs: renderJobs, today: renderToday, chat: renderChat, trades: renderTrades, research: renderResearch, rules: renderRules, ais: renderAis };

  function sliceKey() {
    if (!S) return "";
    const minute = Math.floor(S.server_time / 60000);
    const slices = {
      jobs: [S.jobs, extraJobs, jobOwner, jobStatus, jobsCursor, minute],
      today: [S.jobs, S.chat?.messages, S.board, S.decisions.open, S.plans.filter((p) => p.review_state === "reviewed"), S.connections, S.radar, minute],
      chat: [S.chat.messages.map((m) => m.id), olderChat.length, [...expandedMessages]],
      trades: [S.plans, [...openHistories], Object.keys(historyCache).length, Math.floor(minute / 5)],
      research: [S.research, S.radar, S.board?.snapshot?.positions, researchSymbol, researchCategory, Math.floor(minute / 5)],
      rules: [S.rules],
      ais: [S.connections, S.connector_address, S.helpers, Math.floor(minute / 5)],
    };
    return JSON.stringify(slices[tab]);
  }

  function badges() {
    const need = S ? needsYou().total : 0;
    const set = (id, n) => {
      const el = document.getElementById(id);
      el.hidden = !n;
      el.textContent = n > 99 ? "99+" : String(n);
    };
    set("badge-today", need);
    set("badge-jobs", S ? ((S.jobs?.counts.blocked || 0) + (S.jobs?.counts.review || 0)) : 0);
    set("badge-chat", tab === "chat" ? 0 : S ? S.unread : 0);
    set("badge-trades", S ? S.plans.filter((p) => p.review_state === "reviewed").length : 0);
    document.querySelectorAll(".tabs button").forEach((b) => (b.dataset.tab === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    $("#top-note").textContent = S ? "Workspace synced · " + clock(S.server_time) : "Connecting…";
  }

  // Keep job drafts local to this browser tab, never in the shared board. The
  // in-memory copy handles polling/filter re-renders; sessionStorage also lets a
  // real page reload restore an unfinished form without carrying it to other tabs.
  // Storage can be unavailable, so every access is best-effort.
  const JOB_DRAFTS_STORAGE = "driftline-job-drafts-v1";
  const jobDrafts = new Map();
  try {
    const saved = JSON.parse(sessionStorage.getItem(JOB_DRAFTS_STORAGE) || "[]");
    if (Array.isArray(saved)) for (const entry of saved.slice(-50)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1] && typeof entry[1] === "object") jobDrafts.set(entry[0], entry[1]);
    }
  } catch {}
  function persistJobDrafts() {
    try {
      const saved = [...jobDrafts].filter(([, draft]) => Object.keys(draft.values || {}).length || draft.retryKey).slice(-50);
      if (saved.length) sessionStorage.setItem(JOB_DRAFTS_STORAGE, JSON.stringify(saved));
      else sessionStorage.removeItem(JOB_DRAFTS_STORAGE);
    } catch {}
  }
  function jobFormKey(form) { return form.id === "job-form" ? "create" : form.dataset.jobUpdate; }
  function jobFields(form) { return [...form.elements].filter(el => el.name && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); }
  function rememberJobDrafts() {
    for (const form of view.querySelectorAll("#job-form, form[data-job-update]")) {
      const fields = jobFields(form);
      const dirty = fields.some(el => el.tagName === "SELECT"
        ? el.value !== ([...el.options].find(o => o.defaultSelected)?.value ?? el.options[0]?.value ?? "")
        : el.value !== el.defaultValue);
      const key = jobFormKey(form);
      const open = form.closest("details")?.open;
      const edited = dirty || !!form.dataset.retryKey;
      if (!edited && !open) { jobDrafts.delete(key); continue; }
      jobDrafts.set(key, {
        values: edited ? Object.fromEntries(fields.map(el => [el.name, el.value])) : {},
        version: edited ? form.dataset.version : undefined, retryKey: form.dataset.retryKey,
        open,
      });
    }
    persistJobDrafts();
  }
  function restoreJobDrafts() {
    for (const form of view.querySelectorAll("#job-form, form[data-job-update]")) {
      const draft = jobDrafts.get(jobFormKey(form));
      if (!draft) continue;
      for (const field of jobFields(form)) {
        if (Object.hasOwn(draft.values, field.name)) field.value = draft.values[field.name];
      }
      // Keep the version the draft was written against. Using the new version here
      // would silently overwrite a teammate's intervening update on submission.
      if (draft.version && form.dataset.version !== draft.version) {
        const notice = document.createElement("p");
        notice.className = "banner";
        notice.textContent = "This job changed while you were editing. Your draft is kept; saving it cannot overwrite the newer version.";
        const discard = document.createElement("button");
        discard.type = "button"; discard.className = "btn small";
        discard.dataset.discardJobDraft = "true";
        discard.textContent = "Discard this draft and load latest";
        form.prepend(notice, discard);
      }
      if (draft.version) form.dataset.version = draft.version;
      if (draft.retryKey) form.dataset.retryKey = draft.retryKey;
      const disclosure = form.closest("details");
      if (disclosure) disclosure.open = draft.open;
    }
  }
  window.addEventListener("pagehide", rememberJobDrafts);

  function typing() {
    const el = document.activeElement;
    return el && view.contains(el) && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.value;
  }

  function render(force) {
    if (!S) return;
    badges();
    const key = sliceKey();
    if (!force && lastRendered.tab === tab && lastRendered.key === key) return;
    if (!force && lastRendered.tab === tab && typing()) return; // never wipe what Casey is typing
    const atBottom = tab === "chat" && window.innerHeight + window.scrollY >= document.body.scrollHeight - 140;
    const firstChat = tab === "chat" && lastRendered.tab !== "chat";
    const draft = tab === "chat" ? $("#composer textarea")?.value : "";
    const costForm = tab === "research" ? $("#research-cost-form") : null;
    if (costForm) researchCostDraft = Object.fromEntries(new FormData(costForm));
    rememberJobDrafts();
    view.innerHTML = RENDER[tab]();
    restoreJobDrafts();
    if (tab === "research" && researchCostDraft) {
      const form = $("#research-cost-form");
      for (const [name, value] of Object.entries(researchCostDraft)) {
        const field = form?.elements.namedItem(name);
        if (field) field.value = value;
      }
      if (researchCostResult) $("#research-cost-result").textContent = researchCostResult;
    }
    lastRendered = { key, tab };
    measureChrome();
    if (tab === "chat") {
      if (draft) $("#composer textarea").value = draft;
      if (atBottom || firstChat) window.scrollTo(0, document.body.scrollHeight);
      if (document.visibilityState === "visible") markChatSeen();
    }
  }

  // One source of truth for how much room the floating chrome needs at the bottom.
  //
  // This used to be three hand-maintained numbers that had to agree: --tabs-h, a
  // hardcoded .composer bottom of 100px, and 85px again in the mobile block. ChatGPT
  // pointed out that my earlier "measured" fix did not actually drive the composer at
  // all, because those later rules overrode it. It worked only because the bar happened
  // to fit one row again. So now the geometry is measured and the CSS follows it.
  //
  // --nav-clear is the distance from the top of the tab bar to the bottom of the
  // viewport, which already includes the bar's height, its floating margin and the
  // safe-area inset, because it is read off the rendered element.
  function measureChrome() {
    const bar = document.querySelector(".tabs");
    if (!bar) return;
    const root = document.documentElement;
    const clear = Math.round(window.innerHeight - bar.getBoundingClientRect().top);
    const box = document.querySelector("#composer");
    const composerH = box ? Math.round(box.getBoundingClientRect().height) : 0;
    // Only write when it actually moves. The bar's height does not depend on the
    // composer, so there is no feedback loop today, but a future change that made one
    // would otherwise oscillate forever instead of failing loudly.
    const put = (name, value) => {
      if (value <= 0) return;
      if (root.style.getPropertyValue(name) === value + "px") return;
      root.style.setProperty(name, value + "px");
    };
    put("--nav-clear", clear);
    put("--composer-h", composerH);
  }

  function go(next, scrollTop = true) {
    tab = next;
    sessionStorage.setItem("tab", tab);
    render(true);
    if (scrollTop && tab !== "chat") window.scrollTo(0, 0);
  }

  async function refresh(force) {
    try {
      S = await api("/api/state");
      if (jobsPaged) {
        // Refresh every page already opened, so a remote handoff cannot stay hidden in a stale card.
        const through = Math.max(0, ...extraJobs.map(t=>t.id));
        const updated = []; let cursor = S.jobs.next_after_id;
        while (cursor && cursor < through) {
          const page = await api(`/api/tasks?after=${cursor}`);
          updated.push(...page.tasks); cursor = page.next_after_id;
        }
        extraJobs = updated; jobsCursor = cursor;
      }
      document.getElementById("app").dataset.state = "ready";
      render(force);
      // The ring fill cannot ship in markup: the CSP drops style attributes.
      // Fill it here so it is never briefly empty waiting for the next tick.
      tickScanClock();
    } catch (e) {
      $("#top-note").textContent = "Update failed · showing last loaded data";
      if (!S) view.innerHTML = `<p class="pad">The hub could not load. Check your connection and <button type="button" class="linkish" id="retry">try again</button>.</p>`;
    }
  }

  // ----------------------------------------------------------- actions

  async function act(fn, done) {
    try {
      await fn();
      if (done) toast(done);
      await refresh(true);
    } catch (e) {
      toast(e.message, true);
    }
  }

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) go(b.dataset.tab);
  });

  view.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.dataset.discardJobDraft) {
      const form = t.closest("form");
      form.reset(); delete form.dataset.retryKey;
      jobDrafts.delete(jobFormKey(form));
      persistJobDrafts();
      return render(true);
    }
    if (t.dataset.jobOwner) { jobOwner = t.dataset.jobOwner; return go("jobs"); }
    if (t.hasAttribute("data-research-symbol")) {
      researchSymbol = globalThis.HubResearchDesk.symbol(t.dataset.researchSymbol);
      return render(true);
    }
    if (t.dataset.researchCategory) {
      researchCategory = globalThis.HubResearchDesk.CATEGORIES.some(([id]) => id === t.dataset.researchCategory) ? t.dataset.researchCategory : "all";
      return render(true);
    }
    if (t.id === "research-policy-refresh") {
      t.disabled = true;
      t.textContent = "Reading policy documents…";
      try { researchPolicy = await api("/api/context/policy"); return render(true); }
      catch (error) { toast(error.message, true); }
      finally { if (t.isConnected) { t.disabled = false; t.textContent = "Read recent policy documents"; } }
      return;
    }
    if (t.dataset.deckJobStatus) { jobOwner = "all"; jobStatus = t.dataset.deckJobStatus; return go("jobs"); }
    if (t.dataset.jobHistory) {
      try {
        const result = await api(`/api/tasks/${t.dataset.jobHistory}`);
        return openSheet(`Job #${result.task.id} history`, `<ul class="history-list">${result.history.map(h=>`<li><strong>${esc(h.actor_name)}</strong> · ${esc(h.action)} · ${esc(clock(h.at))}<p>${esc(h.detail)}</p></li>`).join("")}</ul>`);
      } catch (err) { return toast(err.message, true); }
    }
    if (t.id === "load-jobs") {
      try {
        const page = await api(`/api/tasks?after=${jobsCursor || S.jobs.next_after_id}`);
        extraJobs = extraJobs.concat(page.tasks);
        jobsCursor = page.next_after_id;
        jobsPaged = true;

        return render(true);
      } catch (err) { return toast(err.message, true); }
    }
    if (t.dataset.term) {
      const [title, text] = GLOSSARY[t.dataset.term];
      return openSheet(title, `<p>${esc(text)}</p>`);
    }
    if (t.dataset.tabLink) return go(t.dataset.tabLink);
    if (t.id === "retry") return refresh(true);
    if (t.dataset.answer) {
      t.disabled = true;
      return act(() => api(`/api/decisions/${t.dataset.answer}/answer`, { answer: t.dataset.text }), "Answered. Your AIs will see it when they next check in.");
    }
    if (t.dataset.gotoPlan) {
      go("trades", false);
      const el = document.getElementById(`plan-${t.dataset.gotoPlan}`);
      if (el) el.scrollIntoView({ block: "start" });
      return;
    }
    if (t.dataset.planAct) {
      const id = t.dataset.plan;
      if (t.dataset.armed !== "1") {
        // Two taps: the first says exactly what the second will do.
        t.dataset.armed = "1";
        t.textContent = t.dataset.planAct === "approve" ? "Tap again to approve" : "Tap again to decline";
        setTimeout(() => { if (t.isConnected) render(true); }, 5000);
        return;
      }
      t.disabled = true;
      return act(() => api(`/api/plans/${encodeURIComponent(id)}/${t.dataset.planAct}`, {}), t.dataset.planAct === "approve" ? "Approved" : "Declined");
    }
    if (t.dataset.planKind) {
      // Same two-tap arming as approve and decline. This moves a red flag on and
      // off the board, so it should be as hard to do by accident as approving is.
      const id = t.dataset.plan, kind = t.dataset.planKind;
      if (!t.dataset.armed) {
        t.dataset.armed = "1";
        t.textContent = "Tap again to change it";
        setTimeout(() => { if (t.isConnected) render(true); }, 5000);
        return;
      }
      t.disabled = true;
      return act(
        () => api(`/api/plans/${encodeURIComponent(id)}/record-kind`, { record_kind: kind }),
        kind === "existing_holding" ? "Recorded as something you already own" : "Changed back to a trade plan",
      );
    }
    if (t.dataset.planHistory) {
      const id = t.dataset.planHistory;
      if (openHistories.has(id)) openHistories.delete(id);
      else {
        try {
          historyCache[id] = (await api(`/api/plans/${encodeURIComponent(id)}`)).history;
          openHistories.add(id);
        } catch (err) { return toast(err.message, true); }
      }
      return render(true);
    }
    if (t.dataset.expand) {
      expandedMessages.add(Number(t.dataset.expand));
      const y = window.scrollY;
      render(true);
      return window.scrollTo(0, y);
    }
    if (t.id === "load-older") {
      const msgs = allMessages();
      try {
        const page = await api(`/api/chat?before=${msgs[0].id}`);
        olderChat = olderChat.concat(page.messages);
        hasOlder = page.has_older;
        const before = document.body.scrollHeight;
        render(true);
        window.scrollTo(0, window.scrollY + (document.body.scrollHeight - before));
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (t.dataset.disconnect) {
      if (t.dataset.armed !== "1") {
        t.dataset.armed = "1";
        t.textContent = `Tap again to disconnect ${t.dataset.name}`;
        setTimeout(() => { if (t.isConnected) render(true); }, 5000);
        return;
      }
      t.disabled = true;
      return act(() => api(`/api/connections/${encodeURIComponent(t.dataset.disconnect)}/disconnect`, {}), `${t.dataset.name} is disconnected`);
    }
    if (t.id === "lab-refresh") {
      t.disabled = true;
      return act(async () => { S.research = await api("/api/research/refresh", {}); }, "Lab read again");
    }
    if (t.dataset.helper) {
      t.disabled = true;
      const on = t.dataset.to === "on";
      return act(() => api("/api/helpers", { [t.dataset.helper]: on }), on ? "Turned on" : "Turned off");
    }
    if (t.id === "copy-address") {
      const input = $("#connector-address");
      try {
        await navigator.clipboard.writeText(input.value);
        toast("Address copied");
      } catch {
        input.select();
        toast("Press and hold the address to copy it");
      }
    }
  });

  view.addEventListener("submit", async (e) => {
    const form = e.target;
    if (form.getAttribute("action") === "/sign-out") return; // a plain form post
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type="submit"]');
    if (form.id === "research-symbol-form") {
      const value = globalThis.HubResearchDesk.symbol(data.symbol);
      if (String(data.symbol).trim() && !value) return toast("Enter a stock or ETF ticker, using letters, numbers, dots or dashes.", true);
      researchSymbol = value;
      return render(true);
    }
    if (form.id === "research-cost-form") {
      const result = globalThis.HubResearchDesk.costModel(...["position","target","stop","cost"].map(k => data[k] === "" ? NaN : Number(data[k])));
      if (!result) return toast("Use positive position, target and stop values, a stop under 100%, and nonnegative costs.", true);
      researchCostDraft = data;
      researchCostResult = `Net target ${money(result.gain)} · Modeled stop loss ${money(result.loss)} · ${result.breakEven === null ? "Costs consume the entire target; no positive target outcome in this model." : `Break-even win rate ${result.breakEven.toFixed(1)}% in this two-outcome model.`}`;
      $("#research-cost-result").textContent = researchCostResult;
      return;
    }
    if (form.id === "job-form") {
      const dependencies = String(data.dependencies || "").trim();
      const ids = dependencies ? dependencies.split(",").map(v=>Number(v.trim())) : [];
      if (ids.some(n=>!Number.isSafeInteger(n) || n < 1)) return toast("Use positive task numbers separated by commas", true);
      button.disabled = true;
      form.dataset.retryKey ||= crypto.randomUUID();
      try {
        await api("/api/tasks", { ...data, dependencies: ids, idempotency_key: form.dataset.retryKey });
        form.reset(); delete form.dataset.retryKey;
        rememberJobDrafts();
        await refresh(true); toast("Job created");
      } catch (err) { toast(err.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (form.dataset.jobUpdate) {
      button.disabled = true;
      try {
        const result = await api(`/api/tasks/${form.dataset.jobUpdate}`, { ...data, expected_version: Number(form.dataset.version) });
        extraJobs = extraJobs.map(t=>t.id === result.task.id ? result.task : t);
        form.reset(); // successful submission clears this draft before the next render
        delete form.dataset.retryKey;
        rememberJobDrafts();
        await refresh(true); toast("Job updated");
      } catch (err) { toast(err.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
      return;
    }
    if (form.dataset.answerForm) {
      if (!String(data.answer || "").trim()) return toast("Type an answer first", true);
      button.disabled = true;
      return act(() => api(`/api/decisions/${form.dataset.answerForm}/answer`, { answer: data.answer }), "Answered. Your AIs will see it when they next check in.");
    }
    if (form.id === "composer") {
      const body = String(data.body || "").trim();
      if (!body) return;
      button.disabled = true;
      try {
        await api("/api/chat", { body, idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
        form.reset();
        form.querySelector("textarea").style.height = "";
        await refresh(true);
        window.scrollTo(0, document.body.scrollHeight);
        // The helpers answer a few seconds after you send, so look again shortly.
        for (const wait of [4000, 9000, 20000]) setTimeout(() => refresh(false), wait);
      } catch (err) {
        toast(err.message, true);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
      return;
    }
    if (form.id === "rules-form") {
      button.disabled = true;
      return act(() => api("/api/rules", data), "Rules saved as a new version");
    }
    if (form.id === "pass-form") {
      button.disabled = true;
      return act(() => api("/api/passphrase", data), "Passphrase changed");
    }
  });

  view.addEventListener("change", e => {
    if (e.target.id === "job-owner") { jobOwner = e.target.value; render(true); }
    if (e.target.id === "job-status") { jobStatus = e.target.value; render(true); }
  });

  view.addEventListener("input", (e) => {
    if (e.target.matches("#composer textarea")) {
      e.target.style.height = "auto";
      e.target.style.height = Math.min(e.target.scrollHeight, window.innerHeight * 0.4) + "px";
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    measureChrome(); // the bar's height can change with the width, on every tab, not just today
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (tab === "today" && !typing()) render(true); }, 200);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh(false);
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh(false);
  }, 15000);
  // One second, text only, no re-render. Stops while the tab is hidden so a
  // phone in a pocket is not running a clock nobody is reading.
  setInterval(() => {
    if (document.visibilityState === "visible") tickScanClock();
  }, 1000);

  refresh(true);
})();
