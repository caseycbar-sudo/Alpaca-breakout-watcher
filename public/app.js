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
  let tab = TABS.includes(sessionStorage.getItem("tab")) ? sessionStorage.getItem("tab") : "jobs";
  let olderChat = []; // pages loaded with "Show earlier messages"
  let hasOlder = false;
  let lastRendered = { key: "", tab: "" };
  let openHistories = new Set();
  let historyCache = {};
  let expandedMessages = new Set();

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
      <h3>${esc(t.title)}</h3><p class="meta"><strong class="status-pill ${esc(t.status)}">${esc(jobStates[t.status])}</strong> · ${esc(people[t.owner_id] || t.owner_id)}${t.status === "proposed" ? " (not yet accepted)" : ""} · Reviewer: ${esc(people[t.reviewer_id] || "Casey")}</p>
      <p class="job-copy">${esc(t.description)}</p>
      <p class="job-copy"><strong>Next:</strong> ${esc(t.next_action)}</p>
      ${t.blocker ? `<p class="banner job-copy"><strong>Blocked:</strong> ${esc(t.blocker)}</p>` : ""}
      ${t.stale ? `<p class="meta">No update in over 24 hours. Check whether the owner can continue.</p>` : ""}
      <details><summary>Acceptance criteria${t.dependencies.length ? " and dependencies" : ""}</summary><p class="job-copy">${esc(t.acceptance)}</p>${t.dependencies.length ? `<p>Depends on: ${t.dependencies.map(id=>`#${id}`).join(", ")}</p>` : ""}${t.evidence ? `<p class="job-copy"><strong>Submitted evidence:</strong> ${esc(t.evidence)}</p>` : ""}</details>
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
    return `<section class="section jobs-section"><div class="job-hero"><span class="eyebrow">THE SHARED WORKSPACE</span><h1>Good ideas.<br><em>Visible progress.</em></h1>
      <p class="sub">The job list for your whole team. Know who owns the next move.</p>${jobStats()}</div>
      <div class="section-heading"><div><span class="eyebrow">PEOPLE & AGENTS</span><h2>Your team’s work</h2></div><span class="quiet small-copy">Tap a teammate to filter</span></div>
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

  function renderToday() {
    const need = needsYou();
    const stops = S.board.exceptions.filter((e) => e.level === "stop");
    const s = S.board.snapshot;
    let head, cls = "";
    if (stops.length) { head = "Stop and look."; cls = "stop"; }
    else if (need.total) head = `${count(need.total, "thing needs", "things need")} you.`;
    else head = "Nothing needs you right now.";
    const sub = stops.length
      ? stops[0].text
      : `No order can be placed from this hub, and no ${term("engine", "trading engine")} is running. ` +
        (s ? `The account numbers below are ${esc(s.age_words)} old.` : "No account numbers have been reported yet.");
    const flags = S.board.exceptions;
    const history = [...(S.board.historical_details || []), ...(S.board.historical_notices || [])];
    const r = S.board.rules;
    return `<section class="notice ${cls}"><h1>${esc(head)}</h1><p>${stops.length ? esc(sub) : sub}</p></section>
      ${driftline()}
      <section class="section"><h2>Project work</h2>${jobStats()}<button type="button" class="btn" data-tab-link="jobs">Open jobs and next actions</button></section>
      ${need.total ? `<section class="section"><h2>Needs you</h2>${need.questions.map(slipFor).join("")}${need.approvals.map(approvalSlip).join("")}</section>` : ""}
      <section class="section"><h2>Your account</h2>${ledger()}</section>
      <section class="section"><h2>Flags</h2>
        ${flags.length
          ? `<ul class="flags">${flags.map((f) => `<li class="${f.level}"><span class="dot" aria-hidden="true"></span><span>${esc(f.text)}</span></li>`).join("")}</ul>`
          : `<p class="sub">Nothing flagged. The hub checks for missing stops, out-of-date numbers, and anything outside your rules.</p>`}
        ${history.length ? `<details class="gloss"><summary>Historical protection details (${history.length})</summary><p class="sub">Source, date and account-matching caveats are retained below. Reports from other histories leave active flags after 72 elapsed hours; that does not resolve them or confirm current holdings.</p><ul>${history.map((h) => `<li>${esc(h.text)}</li>`).join("")}</ul></details>` : ""}
      </section>
      <section class="section"><h2>Your rules, version ${r.version}</h2>
        <p class="sub">At most ${esc(money(r.max_per_trade))} per trade. No new orders once down ${esc(money(r.daily_trigger))} on the day. At most ${r.max_positions} positions. ${esc(r.instruments)}.
        <button type="button" class="linkish" data-tab-link="rules">See or change the rules</button></p>
      </section>`;
  }

  // ------------------------------------------------------------- chat

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

  function planHtml(p) {
    const reviewed = ["reviewed", "authorized"].includes(p.review_state);
    const objected = p.review_state === "objected";
    const approved = p.review_state === "authorized";
    const declined = p.review_state === "declined";
    const history = openHistories.has(p.id) ? historyCache[p.id] : null;
    const canDecline = !declined && p.order_state === "none";
    return `<article class="plan" id="plan-${esc(p.id)}">
      <div class="plan-head"><h3>${esc(p.symbol)}</h3><span class="id">Plan ${esc(p.id)} by ${esc(p.author_name)}, ${esc(ago(p.created_at))}</span></div>
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
        ${p.review_state === "reviewed" ? `<button type="button" class="btn primary" data-plan-act="approve" data-plan="${esc(p.id)}">Approve this plan</button>` : ""}
        ${canDecline ? `<button type="button" class="btn${p.review_state === "reviewed" ? "" : " small"}" data-plan-act="decline" data-plan="${esc(p.id)}">Decline</button>` : ""}
        <button type="button" class="btn small" data-plan-history="${esc(p.id)}">${openHistories.has(p.id) ? "Hide the history" : "Show the history"}</button>
      </div>
      ${history ? `<ul class="history">${history.map((h) => `<li><strong>${esc(h.actor_name)}</strong> ${esc(h.action)} <span class="quiet">${esc(clock(h.at))}</span></li>`).join("")}</ul>` : ""}
    </article>`;
  }

  function renderTrades() {
    return `<section class="section"><h2>Trade plans</h2>
      <p class="sub">Every idea is written down here before anything is bought. A second AI ${term("review", "reviews")} it, then you ${term("approve", "approve")} or decline. Declined and unfilled plans stay, because they are part of the learning.</p>
      ${S.plans.length ? S.plans.map(planHtml).join("") : `<div class="empty">No trade plans yet. When one of your AIs has an idea, it shows up here first, with the price to buy at, where to take profit, and where to get out.</div>`}
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
        ${cards ? `<p class="lead">Today's readings</p>${cards}` : ""}
        ${sw.strategies?.length ? `<p class="lead">What it found, best risk-adjusted first</p>
          ${labTable(sw.strategies, [["Strategy", (x) => x.name], ["Return a year", (x) => (x.cagr === null ? "–" : x.cagr + "%")], ["Worst fall", (x) => (x.worst_drawdown === null ? "–" : x.worst_drawdown + "%")], ["Sharpe", (x) => (x.sharpe === null ? "–" : x.sharpe)], ["Trades a year", (x) => (x.trades_per_year === null ? "–" : x.trades_per_year)]])}
          <p class="meta">Sharpe is return measured against how bumpy the ride was; higher is steadier for the same return. "Worst fall" is the deepest drop from a high point along the way, which is the part that actually makes people quit.</p>` : ""}
        <p class="meta">Backtests on past data. They say what a rule would have done, not what it will do. Nothing here places an order.</p>
      </section>`;
  }

  function renderResearch() {
    const r = S.research;
    if (!r || r.unavailable) {
      return radarPanel() + `<section class="section"><h2>Your breakout lab</h2>
        <p class="sub">The hub reads the results your watcher publishes, so every trade idea here can be checked against your own history.</p>
        <p class="banner">${esc(r?.unavailable || "Not read yet.")}</p>
        <div class="actions"><button type="button" class="btn" id="lab-refresh">Try again</button></div></section>`;
    }
    const age = r.age_days === null ? "" : r.age_days === 0 ? "today" : r.age_days === 1 ? "yesterday" : `${r.age_days} days ago`;
    return radarPanel() + `<section class="section"><h2>Your breakout lab</h2>
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
      today: [S.jobs?.counts, S.board, S.decisions.open, S.plans.filter((p) => p.review_state === "reviewed"), S.connections, minute],
      chat: [S.chat.messages.map((m) => m.id), olderChat.length, [...expandedMessages]],
      trades: [S.plans, [...openHistories], Object.keys(historyCache).length, Math.floor(minute / 5)],
      research: [S.research, S.radar, Math.floor(minute / 5)],
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
    view.innerHTML = RENDER[tab]();
    lastRendered = { key, tab };
    measureTabs();
    if (tab === "chat") {
      if (draft) $("#composer textarea").value = draft;
      if (atBottom || firstChat) window.scrollTo(0, document.body.scrollHeight);
      if (document.visibilityState === "visible") markChatSeen();
    }
  }

  // The composer and the page padding are both offset by --tabs-h. If the tab bar ever
  // renders taller than that (an extra tab, a wrapped label, a larger font), the offset
  // is wrong and the bar covers whatever sits at the bottom of the page. Measuring it
  // after every render means the layout cannot silently drift out of agreement again.
  function measureTabs() {
    const bar = document.querySelector(".tabs");
    if (!bar) return;
    const h = Math.round(bar.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty("--tabs-h", h + "px");
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
    if (t.dataset.jobOwner) { jobOwner = t.dataset.jobOwner; return go("jobs"); }
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
    if (form.id === "job-form") {
      const dependencies = String(data.dependencies || "").trim();
      const ids = dependencies ? dependencies.split(",").map(v=>Number(v.trim())) : [];
      if (ids.some(n=>!Number.isSafeInteger(n) || n < 1)) return toast("Use positive task numbers separated by commas", true);
      button.disabled = true;
      form.dataset.retryKey ||= crypto.randomUUID();
      try {
        await api("/api/tasks", { ...data, dependencies: ids, idempotency_key: form.dataset.retryKey });
        form.reset(); delete form.dataset.retryKey;
        await refresh(true); toast("Job created");
      } catch (err) { toast(err.message, true); button.disabled = false; }
      return;
    }
    if (form.dataset.jobUpdate) {
      button.disabled = true;
      try {
        const result = await api(`/api/tasks/${form.dataset.jobUpdate}`, { ...data, expected_version: Number(form.dataset.version) });
        extraJobs = extraJobs.map(t=>t.id === result.task.id ? result.task : t);
        await refresh(true); toast("Job updated");
      } catch (err) { toast(err.message, true); button.disabled = false; }
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
    measureTabs(); // the bar's height can change with the width, on every tab, not just today
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (tab === "today" && !typing()) render(true); }, 200);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh(false);
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh(false);
  }, 15000);

  refresh(true);
})();
