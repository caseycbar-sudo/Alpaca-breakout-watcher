// The hub from the outside: Casey's sign-in, and an AI connecting the way ChatGPT,
// Grok or Claude would (register, ask Casey, get a pass, call tools).
import { env as rawEnv, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp";
import { sha256 } from "../src/util";

const env = rawEnv as any;
const BASE = "https://hub.test";
const SETUP_CODE = "TIDE-4417-KELP";
const PASSPHRASE = "clam chowder at the sunday market";

const call = (path: string, init: RequestInit = {}) => (exports as any).default.fetch(new Request(BASE + path, { redirect: "manual", ...init }));
const form = (data: Record<string, string | string[]>) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const x of [v].flat()) body.append(k, x);
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE }, body } as RequestInit;
};
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]);

let session = "";
const asCasey = (extra: Record<string, string> = {}) => ({ Cookie: session, ...extra });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: asCasey({ "Content-Type": "application/json", "X-Hub": "1", Origin: BASE, ...headers }), body: JSON.stringify(body) });

beforeAll(async () => {
  await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('setup_code_hash', ?1)`).bind(await sha256(SETUP_CODE)).run();
});

describe("before Casey has set the hub up", () => {
  it("sends visitors to setup and shows nothing", async () => {
    const home = await call("/");
    expect(home.status).toBe(303);
    expect(home.headers.get("Location")).toBe("/setup");
    expect((await call("/api/state")).status).toBe(401);
  });

  it("refuses a wrong setup code and a short passphrase", async () => {
    const wrong = await call("/setup", form({ code: "NOPE", passphrase: PASSPHRASE, again: PASSPHRASE }));
    expect(wrong.status).toBe(401);
    const short = await call("/setup", form({ code: SETUP_CODE, passphrase: "short", again: "short" }));
    expect(short.status).toBe(400);
    expect(await short.text()).toMatch(/at least 12 characters/);
  });

  it("refuses a setup form posted from another site", async () => {
    const res = await call("/setup", { ...form({ code: SETUP_CODE, passphrase: PASSPHRASE, again: PASSPHRASE }), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });
});

describe("Casey's door", () => {
  it("sets up once with the code, and the code never works again", async () => {
    const res = await call("/setup", form({ code: SETUP_CODE, passphrase: PASSPHRASE, again: PASSPHRASE }));
    expect(res.status).toBe(303);
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toMatch(/^__Host-hub-session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    session = cookie.split(";")[0];
    const again = await call("/setup", form({ code: SETUP_CODE, passphrase: PASSPHRASE, again: PASSPHRASE }));
    expect(again.headers.get("Location")).toBe("/sign-in");
  });

  it("opens the page and the data only with the session", async () => {
    const page = await call("/", { headers: asCasey() });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Security-Policy")).toMatch(/default-src 'none'/);
    expect(await page.text()).toContain("Driftline Trading Hub");
    const state = await (await call("/api/state", { headers: asCasey() })).json() as any;
    expect(state.connector_address).toBe(`${BASE}/mcp`);
    expect(state.rules.current.max_per_trade).toBe(40);
    expect(state.connections).toEqual([]);
    expect((await call("/", { headers: { Cookie: "__Host-hub-session=" + "0".repeat(64) } })).status).toBe(303);
  });

  it("signs in with the passphrase and locks after repeated wrong tries", async () => {
    const good = await call("/sign-in", form({ passphrase: PASSPHRASE, next: "/" }));
    expect(good.status).toBe(303);
    const bad = await call("/sign-in", form({ passphrase: "wrong wrong wrong", next: "/" }));
    expect(bad.status).toBe(401);
    for (let i = 0; i < 8; i++) await call("/sign-in", form({ passphrase: "wrong wrong wrong", next: "/" }));
    const locked = await call("/sign-in", form({ passphrase: PASSPHRASE, next: "/" }));
    expect(locked.status).toBe(429);
    await env.DB.prepare(`DELETE FROM login_attempts`).run();
  });

  it("only redirects back into the hub after sign-in", async () => {
    const res = await call("/sign-in", form({ passphrase: PASSPHRASE, next: "//evil.example/x" }));
    expect(res.headers.get("Location")).toBe("/");
  });

  it("refuses changes that do not come from the hub's own page", async () => {
    const noHeader = await call("/api/chat", { method: "POST", headers: asCasey({ "Content-Type": "application/json" }), body: JSON.stringify({ body: "x" }) });
    expect(noHeader.status).toBe(403);
    const otherSite = await post("/api/chat", { body: "x" }, { Origin: "https://evil.example" });
    expect(otherSite.status).toBe(403);
    const crossSite = await post("/api/chat", { body: "x" }, { "Sec-Fetch-Site": "cross-site" });
    expect(crossSite.status).toBe(403);
    // A real browser sends "Origin: null" on a form post under a strict referrer policy; Sec-Fetch-Site settles it.
    const browserForm = await call("/sign-in", { ...form({ passphrase: PASSPHRASE, next: "/" }), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null", "Sec-Fetch-Site": "same-origin" } });
    expect(browserForm.status).toBe(303);
    expect((await post("/api/chat", { body: "hello agents" })).status).toBe(200);
  });
});

// ---- an AI connecting -------------------------------------------------------

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function connect(clientName: string, pick: Record<string, string | string[]>) {
  const redirectUri = "https://ai.example/callback";
  const reg = await call("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as any;
  const verifier = "v".repeat(64);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "hub:read", state: "s1", resource: `${BASE}/mcp` });

  const page = await call(`/authorize?${query}`, { headers: asCasey() });
  expect(page.status).toBe(200);
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)![1].replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(Number(n)));
  const jar = [session, ...cookiesFrom(page)].join("; ");
  const decided = await call("/authorize", { ...form({ handle, decision: "approve", ...pick }), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Cookie: jar } });
  return { client, redirectUri, verifier, html, decided };
}

async function token(c: { client: any; redirectUri: string; verifier: string; decided: Response }) {
  const back = new URL(c.decided.headers.get("Location")!);
  const res = await call("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, client_id: c.client.client_id, redirect_uri: c.redirectUri, code_verifier: c.verifier, resource: `${BASE}/mcp` }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as any).access_token as string;
}

let rpcId = 0;
async function mcp(access: string | null, method: string, params: unknown = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
  if (access) headers.Authorization = `Bearer ${access}`;
  const res = await call("/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  if (res.status !== 200) return { status: res.status, headers: res.headers, body: null as any };
  const text = await res.text();
  const payload = text.startsWith("{") ? text : text.split("\n").filter((l: string) => l.startsWith("data:")).map((l: string) => l.slice(5)).pop()!;
  return { status: 200, headers: res.headers, body: JSON.parse(payload) };
}
const tool = async (access: string, name: string, args: unknown = {}) => {
  const res = await mcp(access, "tools/call", { name, arguments: args });
  const result = res.body.result;
  const text = result.content[0].text as string;
  return { isError: !!result.isError, text, data: result.isError ? null : JSON.parse(text) };
};

describe("the AI door", () => {
  let grok = "";
  let readOnly = "";

  it("turns away anything without a pass, and says where to get one", async () => {
    const res = await mcp(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/resource_metadata=/);
    expect((await mcp("not-a-real-token", "tools/list")).status).toBe(401);
    const meta = (await (await call("/.well-known/oauth-authorization-server")).json()) as any;
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.registration_endpoint).toBe(`${BASE}/oauth/register`);
  });

  it("will not show the approval page to anyone but Casey", async () => {
    const reg = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "X", redirect_uris: ["https://ai.example/callback"], token_endpoint_auth_method: "none" }) });
    const client = (await reg.json()) as any;
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://ai.example/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256", resource: `${BASE}/mcp` });
    const res = await call(`/authorize?${q}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toMatch(/^\/sign-in\?next=/);
  });

  it("shows Casey who is asking, escaped, and connects with the name he picks", async () => {
    const c = await connect(`<img src=x onerror=alert(1)> Totally Claude`, { agent: "grok", scope: ["hub:chat", "hub:log", "hub:snapshot"] });
    expect(c.html).not.toContain("<img src=x");
    expect(c.html).toContain("ai.example");
    expect(c.decided.status).toBe(302);
    expect(c.decided.headers.get("Location")).toMatch(/^https:\/\/ai\.example\/callback\?/);
    grok = await token(c);

    const me = await tool(grok, "start_here");
    expect(me.data.you.name).toBe("Grok"); // the name Casey chose, not the one the app claimed
    expect(me.data.unread_chat_messages).toBeGreaterThan(0);
  });

  it("offers exactly the agreed tools, and none that can trade, approve or change rules", async () => {
    const list = await mcp(grok, "tools/list");
    const names = list.body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names.some((n: string) => /order|trade|buy|sell|cancel|approve|authorize|rule_change|set_rules/.test(n))).toBe(false);
  });

  it("lets a connected AI read, post, report and plan under its own name", async () => {
    const chat = await tool(grok, "read_chat");
    expect(chat.data.messages.some((m: any) => m.body === "hello agents" && m.from === "Casey")).toBe(true);
    const posted = await tool(grok, "post_message", { body: "Grok here, connected.", idempotency_key: "first" });
    expect(posted.data.from).toBe("Grok");
    const twice = await tool(grok, "post_message", { body: "Grok here, connected.", idempotency_key: "first" });
    expect(twice.data.id).toBe(posted.data.id);

    const snap = await tool(grok, "report_snapshot", { source: "Robinhood agent connection", total_value: 208, cash: 162, buying_power: 162, positions: [{ symbol: "QQQ", quantity: 0.026 }], open_orders: [] });
    expect(snap.data.board.snapshot.reported_by).toBe("Grok");

    const plan = await tool(grok, "save_plan", { symbol: "SPY", what_we_see: "Test of the plumbing", entry_price: 500, stop_price: 495, target_price: 510, size_dollars: 20 });
    expect(plan.data.plan.author_name).toBe("Grok");
    const big = await tool(grok, "save_plan", { symbol: "SPY", what_we_see: "Too big", size_dollars: 500 });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/^over_limit/);
    const self = await tool(grok, "review_plan", { id: plan.data.plan.id, verdict: "reviewed" });
    expect(self.text).toMatch(/^own_plan/);

    const state = (await (await call("/api/state", { headers: asCasey() })).json()) as any;
    expect(state.connections.map((c: any) => c.agent_name)).toEqual(["Grok"]);
    expect(state.connections[0].last_seen).toBeGreaterThan(0);
    expect(state.unread).toBeGreaterThan(0);
  });

  it("holds a read-only AI to reading", async () => {
    const c = await connect("ChatGPT", { agent: "chatgpt" }); // Casey unticked everything but reading
    readOnly = await token(c);
    expect((await tool(readOnly, "get_board")).isError).toBe(false);
    for (const [name, args] of [
      ["post_message", { body: "hi" }],
      ["report_snapshot", { source: "x" }],
      ["save_plan", { symbol: "SPY", what_we_see: "x" }],
      ["ask_casey", { question: "May I?" }],
    ] as const) {
      const res = await tool(readOnly, name, args);
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toMatch(/^not_permitted/);
    }
  });

  it("names a custom AI the way Casey typed it", async () => {
    const c = await connect("Some App", { agent: "other", agent_other: "Gemini", scope: ["hub:chat"] });
    const access = await token(c);
    expect((await tool(access, "start_here")).data.you).toMatchObject({ name: "Gemini", id: "gemini" });
  });

  it("does nothing when Casey says no", async () => {
    const reg = await call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Nope", redirect_uris: ["https://ai.example/callback"], token_endpoint_auth_method: "none" }) });
    const client = (await reg.json()) as any;
    const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://ai.example/callback", code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "z", resource: `${BASE}/mcp` });
    const page = await call(`/authorize?${q}`, { headers: asCasey() });
    const handle = (await page.text()).match(/name="handle" value="([^"]+)"/)![1].replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(Number(n)));
    const res = await call("/authorize", { ...form({ handle, decision: "deny" }), headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE, Cookie: [session, ...cookiesFrom(page)].join("; ") } });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("cuts an AI off the moment Casey disconnects it", async () => {
    const state = (await (await call("/api/state", { headers: asCasey() })).json()) as any;
    const target = state.connections.find((c: any) => c.agent_id === "grok");
    expect((await post(`/api/connections/${target.grant_id}/disconnect`, {})).status).toBe(200);
    expect((await mcp(grok, "tools/list")).status).toBe(401);
    expect((await mcp(readOnly, "tools/list")).status).toBe(200); // the others are untouched
  });

  it("lets Casey approve a reviewed plan, answer a question and export everything", async () => {
    const state = (await (await call("/api/state", { headers: asCasey() })).json()) as any;
    const plan = state.plans[0];
    expect((await post(`/api/plans/${plan.id}/approve`, {})).status).toBe(409); // not reviewed yet
    expect((await post(`/api/plans/${plan.id}/decline`, {})).status).toBe(200);
    const dump = await call("/api/export", { headers: asCasey() });
    const text = await dump.text();
    expect(dump.headers.get("Content-Disposition")).toMatch(/attachment/);
    expect(text).toContain("hello agents");
    expect(text).not.toMatch(/pbkdf2|token_hash|passphrase"/);
  });
});
