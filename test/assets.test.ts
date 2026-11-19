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
