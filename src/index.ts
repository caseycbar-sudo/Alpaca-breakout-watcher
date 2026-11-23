// Driftline Trading Hub.
//
// One Worker, two doors onto the same database:
//   /            Casey's page (his own sign-in)
//   /mcp         the connector for his AIs (each with its own approved grant)
//
// Milestone 1 is a shared board, chat, trade log, rules and decision list.
// It holds no broker credentials and has no ability to place orders.

import { AuthorizationError, CimdFetchError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import * as assistant from "./assistant";
import * as auth from "./auth";
import * as db from "./db";
import * as news from "./news";
import * as radar from "./radar";
import * as research from "./research";
import { getPolicy } from "./policy";
import { handleMcp } from "./mcp";
import * as pages from "./pages";
import * as tasks from "./tasks";
import { type Actor, type Env, HubError, SCOPES, SCOPE_WORDS, json , ownerOnly } from "./util";

interface HubEnv extends assistant.AssistantEnv {
  ASSETS: Fetcher;
  /** Set as a Cloudflare secret. The watcher sends it when it posts a live scan. */
  RADAR_TOKEN?: string;
}

const OWNER_ID = "casey";

// A Preview is this same Worker at a public address, for trying changes out. It
// should have storage, assets and nothing that reaches outside: no watcher token
// to accept scans with, and no wake keys, which would let a page anyone can open
// ring Casey's AIs. previews.* declares what a Preview gets, but a dashboard
// variable, keep_vars or a binding added later could still arrive, so the
// handlers are handed only what a Preview is meant to have.
//
// HUB_URL is dropped on purpose rather than kept. Production may set it to the
// live hub's address; inherited, it would make a Preview publish the live hub's
// origin in its OAuth metadata and send people there to sign in. Dropped, the
// address the request arrived on is used, which is the Preview's own.
//
// The idea is ChatGPT's, from its isolatedEnv in PR #28. Production is untouched:
// this narrows nothing unless previews.vars says HUB_ENV is "preview".
const PREVIEW_KEEPS = ["DB", "OAUTH_KV", "ASSETS", "AI", "HUB_ENV"] as const;

export function previewEnv(env: HubEnv): HubEnv {
  if (env.HUB_ENV !== "preview") return env;
  const kept: Record<string, unknown> = {};
  for (const key of PREVIEW_KEEPS) if (key in env) kept[key] = (env as unknown as Record<string, unknown>)[key];
  return kept as unknown as HubEnv;
}

// ----------------------------------------------------------- the AI door

const apiHandler = {
  async fetch(request: Request, env: HubEnv, ctx: ExecutionContext): Promise<Response> {
    const anyCtx = ctx as unknown as { props?: Record<string, unknown>; auth?: { scope?: string[] } };
    const props = anyCtx.props ?? {};
    const agentId = typeof props.agentId === "string" ? props.agentId : "";
    const agentName = typeof props.agentName === "string" ? props.agentName : "";
    if (!agentId || !agentName) {
      return json({ error: "invalid_token", error_description: "This connection has no identity. Reconnect it from the hub." }, 401);
    }
    // Identity and permissions come from the verified grant, never from anything the caller sends.
    const actor: Actor = { kind: "agent", id: agentId, name: agentName, scopes: anyCtx.auth?.scope ?? [] };
    return handleMcp(request, env, ctx, actor);
  },
};

// --------------------------------------------------------- Casey's door

async function readForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new HubError(400, "bad_form", "That form could not be read.");
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HubError(400, "bad_json", "The request could not be read.");
}

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ Location: to, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

const STATIC = new Set(["/app.css", "/app.js", "/research-desk.js", "/favicon.svg"]);

async function defaultFetch(request: Request, env: HubEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (STATIC.has(path) && (method === "GET" || method === "HEAD")) return env.ASSETS.fetch(request);
  // Cheap after the first call in an isolate, and it must happen before any page is
  // rendered so the shell can stamp its asset URLs.
  await pages.primeAssetStamp(env);
  pages.primePreviewLabel(env);
  if (path === "/api/radar" && request.method === "POST") {
    try {
      const scan = await radar.receive(env, request);
      return json({ ok: true, candidates: scan.candidate_count, generated_at: scan.generated_at });
    } catch (error) {
      if (error instanceof HubError) return json({ error: error.code, message: error.message }, error.status);
      throw error;
    }
  }
  if (path === "/api/news" && request.method === "POST") {
    try {
      const update = await news.receive(env, request);
      return json({ ok: true, items: update.items.length, feed_at: update.feed_at });
    } catch (error) {
      if (error instanceof HubError) return json({ error: error.code, message: error.message }, error.status);
      throw error;
    }
  }
  if (path === "/healthz") {
    // Yes or no only: whether each wake-up's keys are present. Never the keys themselves.
    const wake_keys = {
      claude: !!(env.WAKE_CLAUDE_URL && env.WAKE_CLAUDE_TOKEN),
      grok: !!(env.WAKE_GROK_URL && env.WAKE_GROK_SECRET),
    };
    return json({ ok: true, project_jobs: true, broker_connection: "none", engine: "none", orders_enabled: false, assistant: !!env.AI, wake_keys, radar_feed: !!env.RADAR_TOKEN });
  }

  try {
    if (path === "/setup") return await setupRoute(request, env);
    if (path === "/sign-in") return await signInRoute(request, env, url);
    if (path === "/sign-out" && method === "POST") {
      if (!auth.sameOrigin(request)) throw new HubError(403, "cross_site", "That request did not come from the hub.");
      await auth.endSession(env, request);
      return redirect("/sign-in", auth.clearSessionCookie());
    }
    if (path === "/authorize") return await authorizeRoute(request, env, url);
    if (path.startsWith("/api/")) return await apiRoute(request, env, url, ctx);
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      if (!(await auth.isSetUp(env))) return redirect("/setup");
      if (!(await auth.ownerFromRequest(env, request))) return redirect("/sign-in");
      return pages.appShell();
    }
  } catch (error) {
    if (error instanceof HubError) {
      if (path.startsWith("/api/")) return json({ error: error.code, message: error.message }, error.status);
      return pages.messagePage("That did not work", error.message, error.status);
    }
    throw error;
  }
  return pages.messagePage("Page not found", "There is nothing at this address.", 404);
}

async function setupRoute(request: Request, env: HubEnv): Promise<Response> {
  if (await auth.isSetUp(env)) return redirect("/sign-in");
  if (request.method === "GET") return pages.setupPage();
  if (request.method !== "POST") throw new HubError(405, "bad_method", "Not allowed.");
  if (!auth.sameOrigin(request)) throw new HubError(403, "cross_site", "That request did not come from the hub.");
  const form = await readForm(request);
  const passphrase = String(form.get("passphrase") ?? "");
  if (passphrase !== String(form.get("again") ?? "")) return pages.setupPage("The two passphrases do not match. Type them again.", 400);
  try {
    const cookie = await auth.setUp(env, String(form.get("code") ?? ""), passphrase);
    return redirect("/", cookie);
  } catch (error) {
    if (error instanceof HubError && error.status !== 409) return pages.setupPage(error.message, error.status);
    throw error;
  }
}

async function signInRoute(request: Request, env: HubEnv, url: URL): Promise<Response> {
  if (!(await auth.isSetUp(env))) return redirect("/setup");
  if (request.method === "GET") {
    const next = auth.safeNext(url.searchParams.get("next"));
    if (await auth.ownerFromRequest(env, request)) return redirect(next);
    return pages.signInPage(next);
  }
  if (request.method !== "POST") throw new HubError(405, "bad_method", "Not allowed.");
  if (!auth.sameOrigin(request)) throw new HubError(403, "cross_site", "That request did not come from the hub.");
  const form = await readForm(request);
  const next = auth.safeNext(String(form.get("next") ?? "/"));
  try {
    const cookie = await auth.signIn(env, String(form.get("passphrase") ?? ""));
    return redirect(next, cookie);
  } catch (error) {
    if (error instanceof HubError) return pages.signInPage(next, error.message, error.status);
    throw error;
  }
}

// The approval page for an AI connection. Casey must be signed in to see it.
async function authorizeRoute(request: Request, env: HubEnv, url: URL): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!(await auth.ownerFromRequest(env, request))) {
        return redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return pages.consentPage(details, consent.handle, consent.headers);
    }
    if (request.method !== "POST") throw new HubError(405, "bad_method", "Not allowed.");
    if (!(await auth.ownerFromRequest(env, request))) {
      return pages.messagePage("Sign in first", "Your sign-in ended before you answered. Start the connection again from the AI's settings.", 401);
    }
    const form = await readForm(request);
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const picked = String(form.get("agent") ?? "");
    let agentId = "";
    let agentName = "";
    const known = pages.KNOWN_AGENTS.find((a) => a.id === picked);
    if (known) {
      agentId = known.id;
      agentName = known.name;
    } else {
      agentName = String(form.get("agent_other") ?? "").trim().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 30);
      agentId = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (!agentId || agentId === OWNER_ID || agentId === "hub" || agentId === assistant.ASSISTANT_ID) {
        return pages.messagePage("Name the AI", "Go back and say which AI this is, then connect again from the AI's settings.", 400);
      }
    }
    const chosen = new Set(form.getAll("scope").map(String).filter((s) => (SCOPES as readonly string[]).includes(s)));
    chosen.add("hub:read"); // every connection needs to read; the checkbox is locked on.
    const scope = [...chosen, "offline_access"];

    const approved = await oauth.approveConsent(request, handle, { scope });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request, // from the hub's own storage, not from the form
      userId: OWNER_ID,
      metadata: { agentId, agentName },
      scope: approved.request.scope,
      props: { agentId, agentName },
    });
    await env.DB.prepare(
      `INSERT INTO messages (author_kind, author_id, author_name, body, created_at) VALUES ('system','hub','Hub',?1,?2)`,
    )
      .bind(`Casey connected ${agentName} to the hub.`, Date.now())
      .run();
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) {
      return pages.messagePage("This connection request did not work", `${error.description} Start again from the AI's settings.`, 400);
    }
    if (error instanceof CimdFetchError) {
      return pages.messagePage("This app could not be verified", "The hub could not confirm who is asking to connect, so nothing was connected.", 400);
    }
    throw error;
  }
}

async function connections(env: HubEnv) {
  const grants = await env.OAUTH_PROVIDER.listUserGrants(OWNER_ID);
  const seen = await db.agentsSeen(env);
  return grants.items
    .map((g) => {
      const agentId = String(g.metadata?.agentId ?? "");
      const last = seen.find((s) => s.agent_id === agentId);
      return {
        grant_id: g.id,
        agent_id: agentId,
        agent_name: String(g.metadata?.agentName ?? "Unnamed AI"),
        connected_at: g.createdAt * 1000,
        may: SCOPES.filter((s) => g.scope.includes(s)).map((s) => SCOPE_WORDS[s]),
        last_seen: last?.last_seen ?? null,
        last_action: last?.last_action ?? null,
      };
    })
    .sort((a, b) => a.agent_name.localeCompare(b.agent_name));
}

// The JSON behind Casey's page. Every route needs his session.
async function apiRoute(request: Request, env: HubEnv, url: URL, ctx: ExecutionContext): Promise<Response> {
  const owner = await auth.ownerFromRequest(env, request);
  if (!owner) throw new HubError(401, "not_signed_in", "Your sign-in has ended. Sign in again.");
  const path = url.pathname;
  const method = request.method;

  if (method !== "GET") {
    // Changes must come from the hub's own page: same origin, and a header a plain form cannot send.
    if (!auth.sameOrigin(request) || request.headers.get("X-Hub") !== "1") {
      throw new HubError(403, "cross_site", "That request did not come from the hub.");
    }
  }

  if (path === "/api/state" && method === "GET") {
    const [board, chat, open, answered, plans, rules, links, seen, lab, scan, headlines] = await Promise.all([
      db.buildBoard(env),
      db.readChat(env, owner, { limit: 40, mark_read: false }),
      db.listDecisions(env, owner, { status: "open" }),
      db.listDecisions(env, owner, { status: "answered", limit: 10 }),
      db.listPlans(env, owner, { filter: "all", limit: 40 }),
      db.rulesHistory(env),
      connections(env),
      db.agentsSeen(env),
      research.getResearch(env).catch(() => null),
      radar.current(env).catch(() => null),
      news.current(env).catch(() => null),
    ]);
    return json({
      server_time: Date.now(),
      connector_address: `${url.origin}/mcp`,
      unread: await db.unreadCount(env, owner.id),
      board,
      chat,
      decisions: { open, answered },
      plans: plans.plans,
      rules: { current: rules[0], history: rules },
      connections: links,
      seen,
      helpers: await assistant.status(env),
      radar: scan,
      news: headlines,
      research: lab && lab.summary ? { ...lab.summary, read_at: lab.fetched_at, problem: lab.problem ?? null } : { unavailable: lab?.problem ?? "The lab's results have not been read yet." },
      jobs: await tasks.listTasks(env, owner, { status: "all", limit: 100 }),
    });
  }

  if (path === "/api/context/policy" && method === "GET") return json(await getPolicy());

  if (path === "/api/tasks" && method === "GET") {
    return json(await tasks.listTasks(env, owner, {
      status: url.searchParams.get("status") ?? "all", limit: 100,
      ...(url.searchParams.has("after") ? { after_id: Number(url.searchParams.get("after")) } : {}),
    }));
  }
  if (path === "/api/tasks" && method === "POST") return json(await tasks.createTask(env, owner, await readJson(request)));
  const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (taskMatch && method === "GET") return json(await tasks.getTask(env, owner, Number(taskMatch[1])));
  if (taskMatch && method === "POST") return json(await tasks.updateTask(env, owner, { ...await readJson(request), id: Number(taskMatch[1]) }));

  if (path === "/api/chat" && method === "GET") {
    return json(await db.readChat(env, owner, { before_id: url.searchParams.get("before"), limit: 40, mark_read: false }));
  }
  if (path === "/api/chat" && method === "POST") {
    const body = await readJson(request);
    const before = await env.DB.prepare(`SELECT MAX(id) AS m FROM messages`).first<{ m: number | null }>();
    const message = await db.postMessage(env, owner, body.body, body.idempotency_key);
    // Only a genuinely new message from Casey sets anything off; a retried send does not.
    if (message.id > (before?.m ?? 0)) ctx.waitUntil(assistant.onOwnerMessage(env, owner, message));
    return json(message);
  }
  if (path === "/api/research/refresh" && method === "POST") {
    ownerOnly(owner, "refresh the lab findings");
    const fresh = await research.getResearch(env, { refresh: true });
    return json(fresh.summary ? { ...fresh.summary, read_at: fresh.fetched_at, problem: fresh.problem ?? null } : { unavailable: fresh.problem });
  }
  if (path === "/api/helpers" && method === "POST") {
    await assistant.setSwitches(env, owner, await readJson(request));
    return json(await assistant.status(env));
  }
  if (path === "/api/chat/seen" && method === "POST") {
    const body = await readJson(request);
    const id = Number(body.id);
    if (Number.isFinite(id) && id > 0) await db.markRead(env, owner.id, Math.trunc(id));
    return json({ ok: true });
  }

  let m = path.match(/^\/api\/decisions\/(\d+)\/answer$/);
  if (m && method === "POST") {
    const body = await readJson(request);
    return json(await db.answerDecision(env, owner, m[1], body.answer));
  }
  m = path.match(/^\/api\/decisions\/(\d+)\/withdraw$/);
  if (m && method === "POST") return json(await db.withdrawDecision(env, owner, m[1]));

  m = path.match(/^\/api\/plans\/([^/]+)$/);
  if (m && method === "GET") return json(await db.getPlan(env, owner, decodeURIComponent(m[1])));
  m = path.match(/^\/api\/plans\/([^/]+)\/(approve|decline)$/);
  if (m && method === "POST") return json(await db.decidePlan(env, owner, decodeURIComponent(m[1]), m[2] === "approve"));
  // Changing what kind of record something is belongs to Casey alone, so this is
  // the only door to it. Without it the rule would be unenforceable in practice
  // rather than strict: the AIs cannot do it and he would have had no way either.
  m = path.match(/^\/api\/plans\/([^/]+)\/record-kind$/);
  if (m && method === "POST") {
    const body = await readJson(request);
    return json(await db.savePlan(env, owner, { id: decodeURIComponent(m[1]), record_kind: body.record_kind }));
  }

  if (path === "/api/rules" && method === "POST") return json(await db.newRulesVersion(env, owner, await readJson(request)));

  m = path.match(/^\/api\/connections\/([^/]+)\/disconnect$/);
  if (m && method === "POST") {
    const grantId = decodeURIComponent(m[1]);
    const list = await connections(env);
    const target = list.find((c) => c.grant_id === grantId);
    if (!target) throw new HubError(404, "no_such_connection", "That connection no longer exists.");
    await env.OAUTH_PROVIDER.revokeGrant(grantId, OWNER_ID);
    await env.DB.prepare(
      `INSERT INTO messages (author_kind, author_id, author_name, body, created_at) VALUES ('system','hub','Hub',?1,?2)`,
    )
      .bind(`Casey disconnected ${target.agent_name} from the hub.`, Date.now())
      .run();
    return json({ ok: true });
  }

  if (path === "/api/passphrase" && method === "POST") {
    const body = await readJson(request);
    const cookie = await auth.changePassphrase(env, String(body.current ?? ""), String(body.next ?? ""));
    return json({ ok: true }, 200, { "Set-Cookie": cookie });
  }

  if (path === "/api/export" && method === "GET") {
    const data = await db.exportAll(env, owner);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="driftline-hub-export-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }

  throw new HubError(404, "not_found", "There is nothing at this address.");
}

// ------------------------------------------------------------- wiring

const providers = new Map<string, OAuthProvider<HubEnv>>();

/** The hub's public address. Fixed by HUB_URL when set, otherwise the address the request arrived on. */
function originFor(request: Request, env: HubEnv): string {
  if (env.HUB_URL) return new URL(env.HUB_URL).origin;
  return new URL(request.url).origin;
}

function providerFor(origin: string): OAuthProvider<HubEnv> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<HubEnv>({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler: { fetch: defaultFetch },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [...SCOPES, "offline_access"],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      requiredScopes: ["hub:read"],
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: HubEnv, ctx: ExecutionContext): Promise<Response> | Response {
    // Narrow first, so the Preview's own origin is what everything downstream sees.
    const scoped = previewEnv(env);
    return providerFor(originFor(request, scoped)).fetch(request, scoped, ctx);
  },
} satisfies ExportedHandler<HubEnv>;
