// Server-rendered pages: the app shell, sign-in, first-time setup, and the page
// where Casey approves an AI's connection. Everything an AI or a stranger could
// have typed is escaped before it is shown.

import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { MIN_PASSPHRASE } from "./auth";
import { SCOPES, SCOPE_WORDS, escapeHtml } from "./util";

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

// The consent page posts a form that ends in a redirect to the AI's own site,
// so it must not carry a form-action restriction. Every other page does.
const CSP_STRICT =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const CSP_CONSENT =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'";

function page(title: string, body: string, opts: { script?: boolean; status?: number; csp?: string; headers?: Headers } = {}): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0E3A4A">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
${body}
${opts.script ? '<script src="/app.js" defer></script>' : ""}
</body>
</html>`;
  const headers = new Headers(opts.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  if (!headers.has("Content-Security-Policy")) headers.set("Content-Security-Policy", opts.csp ?? CSP_STRICT);
  return new Response(html, { status: opts.status ?? 200, headers });
}

export function appShell(): Response {
  return page(
    "Driftline Trading Hub",
    `<div id="app" class="app" data-state="loading">
  <header class="top">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M3 13c5-7 9 7 14 0s9-1 12 0M3 20c5-7 9 7 14 0s9-1 12 0" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></span><span class="wordmark">DRIFTLINE<span class="brand-sub">TRADING HUB</span></span></div>
    <span class="top-note" id="top-note"></span>
  </header>
  <main id="view" class="view" tabindex="-1"><p class="quiet pad">Loading the hub…</p></main>
  <nav class="tabs" aria-label="Sections">
    <button type="button" data-tab="today" aria-current="page"><span class="nav-icon" aria-hidden="true">◈</span>Overview<span class="badge" id="badge-today" hidden></span></button>
    <button type="button" data-tab="jobs"><span class="nav-icon" aria-hidden="true">▤</span>Jobs<span class="badge" id="badge-jobs" hidden></span></button>
    <button type="button" data-tab="chat"><span class="nav-icon" aria-hidden="true">◌</span>Chat<span class="badge" id="badge-chat" hidden></span></button>
    <button type="button" data-tab="trades"><span class="nav-icon" aria-hidden="true">↗</span>Plans<span class="badge" id="badge-trades" hidden></span></button>
    <button type="button" data-tab="rules"><span class="nav-icon" aria-hidden="true">☷</span>Rules</button>
    <button type="button" data-tab="ais"><span class="nav-icon" aria-hidden="true">◎</span>Team</button>
  </nav>
  <div class="sheet" id="sheet" hidden>
    <div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <h2 id="sheet-title"></h2>
      <div id="sheet-body"></div>
      <button type="button" class="btn" id="sheet-close">Got it</button>
    </div>
  </div>
</div>
<noscript><p class="pad">This page needs JavaScript turned on.</p></noscript>`,
    { script: true },
  );
}

function door(title: string, lead: string, form: string, error?: string, status = 200): Response {
  return page(
    title,
    `<main class="door">
  <p class="wordmark">Driftline Trading Hub</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">${lead}</p>
  ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ""}
  ${form}
</main>`,
    { status },
  );
}

export function signInPage(next: string, error?: string, status = 200): Response {
  return door(
    "Sign in",
    "This is your private trading hub. Enter your passphrase to open it.",
    `<form method="post" action="/sign-in" class="stack">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="text" name="username" value="Casey" autocomplete="username" hidden>
  <label for="passphrase">Passphrase</label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
  <button class="btn primary" type="submit">Sign in</button>
</form>`,
    error,
    status,
  );
}

export function setupPage(error?: string, status = 200): Response {
  return door(
    "Set up your hub",
    "You do this once. Enter the setup code Claude gave you, then choose a passphrase only you know. A short sentence is easy to remember and hard to guess.",
    `<form method="post" action="/setup" class="stack">
  <input type="text" name="username" value="Casey" autocomplete="username" hidden>
  <label for="code">Setup code</label>
  <input id="code" name="code" type="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required autofocus>
  <label for="passphrase">Choose a passphrase <span class="quiet">(at least ${MIN_PASSPHRASE} characters)</span></label>
  <input id="passphrase" name="passphrase" type="password" autocomplete="new-password" minlength="${MIN_PASSPHRASE}" required>
  <label for="again">Type it again</label>
  <input id="again" name="again" type="password" autocomplete="new-password" minlength="${MIN_PASSPHRASE}" required>
  <button class="btn primary" type="submit">Set up and open the hub</button>
</form>`,
    error,
    status,
  );
}

export function messagePage(title: string, text: string, status = 400): Response {
  return page(
    title,
    `<main class="door">
  <p class="wordmark">Driftline Trading Hub</p>
  <h1>${escapeHtml(title)}</h1>
  <p class="lead">${escapeHtml(text)}</p>
  <p><a class="btn" href="/">Open the hub</a></p>
</main>`,
    { status },
  );
}

export const KNOWN_AGENTS = [
  { id: "claude", name: "Claude", hints: ["claude", "anthropic"] },
  { id: "chatgpt", name: "ChatGPT", hints: ["chatgpt", "openai"] },
  { id: "grok", name: "Grok", hints: ["grok", "x.ai", "xai"] },
] as const;

export function guessAgent(details: ConsentDescription): string {
  const hay = `${details.clientName} ${details.clientDomain ?? ""} ${details.clientUri ?? ""} ${details.redirectHost}`.toLowerCase();
  for (const a of KNOWN_AGENTS) if (a.hints.some((h) => hay.includes(h))) return a.id;
  return "";
}

/** The page where Casey decides whether an AI may connect, which AI it is, and what it may do. */
export function consentPage(details: ConsentDescription, handle: string, headers: Headers, error?: string): Response {
  const guess = guessAgent(details);
  const who = KNOWN_AGENTS.map(
    (a) => `<label class="choice"><input type="radio" name="agent" value="${a.id}" ${guess === a.id ? "checked" : ""} required> ${a.name}</label>`,
  ).join("\n");
  const scopes = SCOPES.map((s) => {
    const locked = s === "hub:read";
    return `<label class="choice"><input type="checkbox" name="scope" value="${s}" checked ${locked ? "disabled" : ""}> ${escapeHtml(SCOPE_WORDS[s])}${locked ? ' <span class="quiet">(always needed)</span>' : ""}</label>`;
  }).join("\n");
  const origin = details.clientDomain
    ? `It is published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "It gave its own name, which the hub cannot verify.";
  return page(
    "Connect an AI",
    `<main class="door">
  <p class="wordmark">Driftline Trading Hub</p>
  <h1>Connect an AI to your hub?</h1>
  <p class="lead">An app calling itself <strong>${escapeHtml(details.clientName)}</strong> is asking to connect. ${origin}
  Its access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? '<p class="alert">This sends access to an app on your own device. Continue only if you just started connecting from it.</p>' : ""}
  <p class="lead">Only continue if you started this yourself, just now, from that AI's settings.</p>
  ${error ? `<p class="alert" role="alert">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/authorize" class="stack">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    <fieldset>
      <legend>Which AI is this?</legend>
      <p class="quiet">Its messages will be signed with this name. You decide the name, not the app.</p>
      ${who}
      <label class="choice"><input type="radio" name="agent" value="other" ${guess ? "" : "checked"}> Another AI, called
        <input type="text" name="agent_other" maxlength="30" aria-label="Name of the other AI" class="inline-input"></label>
    </fieldset>
    <fieldset>
      <legend>What may it do?</legend>
      ${scopes}
      <p class="quiet">It can never place or cancel an order, change your rules, or approve a trade plan. The hub has no way to do those for any AI.</p>
    </fieldset>
    <div class="row">
      <button class="btn primary" name="decision" value="approve" type="submit">Connect</button>
      <button class="btn" name="decision" value="deny" type="submit" formnovalidate>Do not connect</button>
    </div>
  </form>
</main>`,
    { headers, csp: CSP_CONSENT },
  );
}
