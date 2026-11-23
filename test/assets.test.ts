import { describe, it, expect, afterEach } from "vitest";
import * as pages from "../src/pages";

// ChatGPT's catch on job #12. The first cache-busting fix read app.js's ETag and hung
// it on both files. Almost every change that day was CSS-only, which leaves app.js
// byte-identical, so the stylesheet URL would never have moved and the stale-page bug
// would have survived its own fix. These two tests are exactly that scenario in both
// directions.
const envWith = (etags: Record<string, string>) => ({
  ASSETS: {
    fetch: async (r: Request) => {
      const path = new URL(r.url).pathname;
      return new Response("", { headers: etags[path] ? { etag: `"${etags[path]}"` } : {} });
    },
  },
});

const urlsOf = async (etags: Record<string, string>) => {
  pages.setAssetStampsForTest(null);
  await pages.primeAssetStamp(envWith(etags));
  const html = await pages.appShell().text();
  return {
    css: (html.match(/\/app\.css(\?v=[a-zA-Z0-9]*)?/) ?? [])[0],
    js: (html.match(/\/app\.js(\?v=[a-zA-Z0-9]*)?/) ?? [])[0],
  };
};

afterEach(() => pages.setAssetStampsForTest(null));

describe("asset cache stamps", () => {
  it("moves the stylesheet URL when only the CSS changed", async () => {
    const before = await urlsOf({ "/app.js": "jsAAA", "/app.css": "cssAAA" });
    const after = await urlsOf({ "/app.js": "jsAAA", "/app.css": "cssBBB" });
    expect(after.css).not.toBe(before.css);
    // and the untouched file keeps its URL, so it stays cached
    expect(after.js).toBe(before.js);
  });

  it("moves the script URL when only the JavaScript changed", async () => {
    const before = await urlsOf({ "/app.js": "jsAAA", "/app.css": "cssAAA" });
    const after = await urlsOf({ "/app.js": "jsBBB", "/app.css": "cssAAA" });
    expect(after.js).not.toBe(before.js);
    expect(after.css).toBe(before.css);
  });

  it("goes out unstamped rather than inventing a value that churns", async () => {
    const { css, js } = await urlsOf({});
    expect(css).toBe("/app.css");
    expect(js).toBe("/app.js");
  });
});

describe("recovering asset stamps", () => {
  it("retries missing files after a partial failure without refetching successful ones", async () => {
    const paths: string[] = [];
    let fail = true;
    const env = { ASSETS: { fetch: async (r: Request) => {
      const path = new URL(r.url).pathname;
      paths.push(path);
      return fail && path === '/app.css'
        ? new Response('unavailable', { status: 503, headers: { etag: 'error-page' } })
        : new Response('', { headers: { etag: path === '/app.css' ? 'cssOK' : 'jsOK' } });
    } } };
    await pages.primeAssetStamp(env);
    expect(pages.assetStampsForTest()).toEqual({ '/app.js': 'jsOK' });
    fail = false;
    await pages.primeAssetStamp(env);
    expect(pages.assetStampsForTest()).toEqual({ '/app.js': 'jsOK', '/app.css': 'cssOK' });
    expect(paths.filter(p => p === '/app.js')).toHaveLength(1);
    expect(paths.filter(p => p === '/app.css')).toHaveLength(2);
  });
});

// A Preview runs the live code against the test database at a public URL. It has
// to announce itself, or made-up numbers read as Casey's account. See job #14.
describe("telling a preview apart from the real hub", () => {
  const shellWith = (env: { HUB_ENV?: string }) => {
    pages.primePreviewLabel(env);
    return pages.appShell().text();
  };

  it("marks every page of a preview, in the title and on the page", async () => {
    const html = await shellWith({ HUB_ENV: "preview" });
    expect(html).toContain("<title>TEST · ");
    expect(html).toContain("TEST COPY.");
    expect(html).toContain("no connection to Casey's account");
    // Above the app, not buried under it, so a phone shows it first.
    expect(html.indexOf("TEST COPY.")).toBeLessThan(html.indexOf('id="app"'));
  });

  it("leaves the real hub alone, including when the variable is missing or odd", async () => {
    for (const env of [{}, { HUB_ENV: "production" }, { HUB_ENV: "" }]) {
      const html = await shellWith(env);
      expect(html).not.toContain("TEST COPY.");
      expect(html).toContain("<title>Driftline Trading Hub<");
    }
  });

  it("stops marking pages as soon as an isolate serves the real hub again", async () => {
    await shellWith({ HUB_ENV: "preview" });
    expect(pages.previewLabelForTest()).toBe("preview");
    await shellWith({});
    expect(pages.previewLabelForTest()).toBe(null);
  });
});
