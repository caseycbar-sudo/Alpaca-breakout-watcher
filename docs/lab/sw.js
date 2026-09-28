/* Driftline Backtest Lab: keeps the app usable without a connection. */
const SHELL = "driftline-lab-shell-v1";
const DATA = "driftline-lab-data-v1";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Results: always try the network, fall back to the last copy kept on this phone.
  if (url.pathname.endsWith("backtest.json")) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(DATA).then(c => c.put("latest.json", copy));
          return response;
        })
        .catch(() => caches.open(DATA)
          .then(c => c.match("latest.json"))
          .then(async hit => {
            if (!hit) throw new Error("offline");
            const headers = new Headers(hit.headers);
            headers.set("x-from-cache", "1");
            return new Response(await hit.blob(), {status: 200, headers});
          }))
    );
    return;
  }

  // App shell: serve from the cache, refresh it in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request, {ignoreSearch: true}).then(hit => {
        const network = fetch(request).then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then(c => c.put(request, copy));
          }
          return response;
        }).catch(() => hit);
        return hit || network;
      })
    );
  }
});
