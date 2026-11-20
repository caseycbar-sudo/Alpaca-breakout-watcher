// Separate entrypoint: production continues to use src/index.ts.
import hub from "./index";
import { type Env, json } from "./util";

type TestEnv = Env & { ASSETS: Fetcher; HUB_TEST_COPY?: string };

// Pass only the isolated storage and assets. Even accidentally added wake, AI,
// radar or production URL bindings cannot reach the application's handlers.
export function isolatedEnv(env: TestEnv, origin: string): Env & { ASSETS: Fetcher } {
  return { DB: env.DB, OAUTH_KV: env.OAUTH_KV, OAUTH_PROVIDER: env.OAUTH_PROVIDER,
    ASSETS: env.ASSETS, HUB_URL: origin };
}

export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext): Promise<Response> {
    if (env.HUB_TEST_COPY !== "synthetic-only") {
      return json({ error: "test_copy_not_configured" }, 503);
    }
    const url = new URL(request.url);
    // The preview must never ingest real watcher data, even with a valid token.
    if (url.pathname === "/api/radar") {
      return json({ error: "test_copy_rejects_watcher_data" }, 403);
    }
    const response = await hub.fetch(request, isolatedEnv(env, url.origin), ctx);
    if (!response.headers.get("Content-Type")?.includes("text/html")) return response;
    return new HTMLRewriter()
      .on("title", { element(el) { el.setInnerContent("TEST · Driftline Hub"); } })
      .on("body", { element(el) {
        el.prepend('<p class="banner" role="status"><strong>TEST HUB — synthetic data only.</strong> Separate workspace; never use real account data here.</p>', { html: true });
      } })
      .transform(response);
  },
} satisfies ExportedHandler<TestEnv>;
