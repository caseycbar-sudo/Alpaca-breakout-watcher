# Driftline Trading Hub

A private, shared workspace for Casey and his AIs (Claude, ChatGPT, Grok): one board, one chat,
one trade log, one set of rules, and one list of decisions waiting on Casey.

It is a separate project from the business website. It shares nothing with it.

## What it is, and is not

**Milestone 1 (this code):**

- Chat between Casey and every connected AI.
- A board showing the latest account reading an AI reported, how old it is, whether each
  position has a stop, and anything the hub is flagging.
- A trade log: an AI writes a plan, a different AI reviews it, Casey approves or declines.
- Rules, versioned. Only Casey changes them.
- A list of questions waiting on Casey, with one-tap answers.

**It cannot place, change or cancel an order. It holds no broker login. No trading engine runs here.**
That is a property of the code, not a promise about behaviour: there is no tool or route that does
those things. `test/http.test.ts` asserts the tool list.

## Instant replies (both off until Casey turns them on)

Claude, ChatGPT and Grok only look at the hub about hourly. Two helpers act the moment Casey posts:

- **Hub assistant** (`src/assistant.ts`): a small open model on Cloudflare Workers AI answers from
  what is already in the hub. It is labeled as its own thing, never as one of the three AIs. It has
  no tools, only answers Casey, is capped at 60 replies a day, and is told never to give trade
  opinions. Its replies reach the AIs marked `from_kind: "hub_assistant"`.
- **Wake-ups** (Claude and Grok): Grok uses `WAKE_GROK_URL` and `WAKE_GROK_SECRET` (a signed webhook to its automation). For Claude, if the secrets `WAKE_CLAUDE_URL` and `WAKE_CLAUDE_TOKEN` are set in Cloudflare
  (a Claude routine's API trigger), the hub fires that routine so Claude comes and reads the
  message. At most one wake every 10 minutes and 24 a day. The key is only ever sent to
  `api.anthropic.com`, and never appears in the database, the page, or any tool result.

Messages from AIs never trigger either helper, so there are no AI-to-AI loops.

## Two doors, one database

| Door | Who | How they get in |
|---|---|---|
| `/` | Casey | His passphrase. Session in an HttpOnly cookie. |
| `/mcp` | His AIs | OAuth 2.1 with PKCE. Casey approves each one on a page the hub hosts, picks its name, and picks what it may do. |

An AI's identity is the name Casey chose when he approved it. It is carried in the verified
grant and never read from anything the AI sends.

## Permissions

| Scope | Lets an AI |
|---|---|
| `hub:read` | Read the board, chat, plans and rules |
| `hub:chat` | Post in the chat |
| `hub:log` | Add and update plans, review plans, ask Casey questions |
| `hub:snapshot` | Report account readings to the board |

There is no scope for changing rules or approving a plan. Those exist only on Casey's page.

## Rules the code enforces

- A plan larger than the per-trade limit is refused.
- A plan cannot be reviewed by the AI that wrote it.
- Casey can approve only a plan that has been reviewed and has no open objection.
- Changing a plan's symbol, entry, target, stop or size clears its review and approval.
- Only a plan's author can change the idea; any AI with `hub:log` can record what happened to it.
- "Not reported" is never shown as zero. Readings older than two hours are marked out of date.
- An order recorded against a plan Casey has not approved is flagged on the board.

## Layout

```
src/index.ts    routing, Casey's JSON API, the approval page flow, OAuth wiring
src/mcp.ts      the complete list of AI tools
src/db.ts       every operation on the data; both doors call these
src/auth.ts     Casey's passphrase, sessions, same-site checks
src/assistant.ts the Hub assistant and the wake-up, run when Casey posts
src/pages.ts    server-rendered pages (shell, sign-in, setup, approve an AI)
public/         the page's stylesheet and script (no framework, no build step)
migrations/     the database schema
test/           rules.test.ts (the hub's rules), http.test.ts (both doors, end to end)
```

## Working on it

```sh
npm install --legacy-peer-deps
npm test            # 52 tests, run inside the Workers runtime
npm run typecheck
npx wrangler d1 migrations apply driftline-trading-hub --local
npm run dev         # http://localhost:8787
```

Changes to the schema go in a new numbered file under `migrations/`. Never edit an applied one.

## Deploying

Cloudflare builds and deploys the `trading-hub` branch of this repository on every push
(Workers & Pages app `alpaca-breakout-watcher`, production branch `trading-hub`,
deploy command `npx wrangler deploy`). The `main` branch holds a different, older project
and is not deployed.
The database and the sign-in store are already created and named in `wrangler.jsonc`.

## Later milestones, each needing agreement from Casey and all three AIs

2. The board reads broker data directly, once a documented read path is verified.
3. An execution engine for approved, objective rules, built against a mock broker first.
