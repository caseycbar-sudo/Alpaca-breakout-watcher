import { env as rawEnv } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../src/db';
import * as research from '../src/research';
import type { Env } from '../src/util';
const env = rawEnv as unknown as Env;
const generated = Date.parse('2026-11-01T00:00:00Z');
const DAY = 86_400_000;
const lab = { generated_at: new Date(generated).toISOString(), summary: { learning: { trades: 10, avg_r: -0.2 }, validated: false } };
const originalFetch = globalThis.fetch;
beforeEach(async () => { await db.setSetting(env, 'research_summary', ''); });
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
describe('cached research age', () => {
  it('updates age and stale status even inside the hourly cache window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(generated + 15 * DAY - 300_000);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(lab))) as typeof fetch;
    const first = await research.getResearch(env, { refresh: true });
    expect(first.summary).toMatchObject({ age_days: 14, stale: false });
    const readsBeforeCache = vi.mocked(globalThis.fetch).mock.calls.length;
    expect(readsBeforeCache).toBeGreaterThan(0);
    clock.mockReturnValue(generated + 15 * DAY + 300_000);
    const cached = await research.getResearch(env);
    expect(cached.from_cache).toBe(true);
    expect(cached.fetched_at).toBe(first.fetched_at);
    expect(cached.summary).toMatchObject({ age_days: 15, stale: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(readsBeforeCache);
  });
  it('retains findings and their original read time but ages them during a prolonged source outage', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(generated);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(lab))) as typeof fetch;
    const first = await research.getResearch(env, { refresh: true });
    clock.mockReturnValue(generated + 20 * DAY);
    globalThis.fetch = vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch;
    const fallback = await research.getResearch(env, { refresh: true });
    expect(fallback.from_cache).toBe(true);
    expect(fallback.fetched_at).toBe(first.fetched_at);
    expect(fallback.problem).toContain('503');
    expect(fallback.summary).toMatchObject({ age_days: 20, stale: true, every_signal: { trades: 10 } });
  });
  it('does not display a negative age when the source clock is slightly ahead', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(generated - 60_000);
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(lab))) as typeof fetch;
    const first = await research.getResearch(env, { refresh: true });
    const cached = await research.getResearch(env);
    expect(first.summary?.age_days).toBe(0);
    expect(cached.summary?.age_days).toBe(0);
  });
  it('reports missing cached findings as unavailable to agents', async () => {
    const clock = Date.now();
    await db.setSetting(env, 'research_summary', JSON.stringify({ fetched_at: clock }));
    globalThis.fetch = vi.fn(async () => { throw new Error('cache should be used'); }) as typeof fetch;
    await expect(research.forAgent(env, { kind: 'agent', id: 'chatgpt', name: 'ChatGPT', scopes: ['hub:read'] }))
      .rejects.toMatchObject({ code: 'lab_unavailable' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

});
