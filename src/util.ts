// Small helpers shared across the hub. No network, no storage.

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  /** Optional fixed public address. When unset, the address the request arrived on is used. */
  HUB_URL?: string;
}

export const SCOPES = ["hub:read", "hub:chat", "hub:log", "hub:snapshot"] as const;
export type Scope = (typeof SCOPES)[number];

/** What each permission means, in the words shown on the approval page. */
export const SCOPE_WORDS: Record<Scope, string> = {
  "hub:read": "Read the board, chat, trade plans and rules",
  "hub:chat": "Post messages in the chat",
  "hub:log": "Add and update trade plans, review plans, and ask you questions",
  "hub:snapshot": "Report account snapshots to the board",
};

export interface Actor {
  kind: "owner" | "agent";
  id: string;
  name: string;
  scopes: string[];
}

export class HubError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function requireScope(actor: Actor, scope: Scope): void {
  if (actor.kind === "owner") return;
  if (!actor.scopes.includes(scope)) {
    throw new HubError(
      403,
      "not_permitted",
      `This connection does not have the "${scope}" permission (${SCOPE_WORDS[scope]}). ` +
        `Casey can grant it by disconnecting and reconnecting this AI from the hub's AIs page.`,
    );
  }
}

export function ownerOnly(actor: Actor, what: string): void {
  if (actor.kind !== "owner") {
    throw new HubError(403, "owner_only", `Only Casey can ${what}. It is done from his page, not through a connector.`);
  }
}

export const now = () => Date.now();

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

const PBKDF2_ROUNDS = 100_000;

export async function hashPassphrase(passphrase: string, saltHex?: string): Promise<string> {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ROUNDS },
    key,
    256,
  );
  return `pbkdf2$${PBKDF2_ROUNDS}$${toHex(salt)}$${toHex(bits)}`;
}

/** Constant-time comparison of two strings of equal expected length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const again = await hashPassphrase(passphrase, parts[2]);
  return safeEqual(again, stored);
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function textOrNull(value: unknown, max = 4000): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}
