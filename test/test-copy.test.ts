import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import testCopy, { isolatedEnv } from "../src/test-copy";

describe("isolated test entrypoint", () => {
  it("marks setup HTML as TEST while preserving the content security policy", async () => {
    const response = await testCopy.fetch(new Request("https://test.invalid/setup"),
      { ...env, HUB_TEST_COPY: "synthetic-only" } as any, { waitUntil() {} } as any);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("TEST · Driftline Hub");
    expect(html).toContain("TEST HUB — synthetic data only.");
  });
  it("fails closed without the explicit test marker", async () => {
    const res = await testCopy.fetch(new Request("https://test.invalid/"), {} as any, {} as any);
    expect(res.status).toBe(503);
  });
  it("rejects watcher ingestion before accessing storage or credentials", async () => {
    const res = await testCopy.fetch(new Request("https://test.invalid/api/radar", {
      method: "POST", headers: { Authorization: "Bearer synthetic-token" }, body: "{}",
    }), { HUB_TEST_COPY: "synthetic-only" } as any, {} as any);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "test_copy_rejects_watcher_data" });
  });
  it("drops external integrations and binds OAuth to the test origin", () => {
    const env = { DB: {}, OAUTH_KV: {}, ASSETS: {}, OAUTH_PROVIDER: {},
      HUB_URL: "https://production.invalid", RADAR_TOKEN: "synthetic", AI: {},
      WAKE_CLAUDE_URL: "https://external.invalid", WAKE_GROK_SECRET: "synthetic" };
    const isolated = isolatedEnv(env as any, "https://test.invalid");
    expect(Object.keys(isolated).sort()).toEqual(["ASSETS", "DB", "HUB_URL", "OAUTH_KV", "OAUTH_PROVIDER"]);
    expect(isolated.HUB_URL).toBe("https://test.invalid");
    expect(isolated.DB).toBe(env.DB);
    expect(isolated.OAUTH_KV).toBe(env.OAUTH_KV);
  });
});
