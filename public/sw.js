// mony-home service worker — hand-rolled, no workbox.
//
// SECURITY BOUNDARY: this app is auth-gated and every HTML page embeds
// financial data, and /api/* responses are per-user. We therefore cache ONLY
// immutable build assets and brand icons. Never add HTML, /api/*, /_next/image
// (it proxies user receipts) or any request-mode:navigate response to CACHE.
// Bump VERSION when the precached asset set changes.
const VERSION = "v1";
const CACHE = `mony-home-static-${VERSION}`;
const PRECACHE = ["/offline.html", "/icon.svg", "/icon-192.png", "/icon-512.png"];

// Immutable, public, same-origin: build assets + brand icons only.
const CACHEABLE = /^\/icon(\.svg|-(?:maskable-)?\d+\.png)$|^\/_next\/static\//;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // POSTs, server actions, non-GET: plain passthrough, never cached.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations are auth-gated server-rendered HTML: network first, never
  // cached; offline falls back to the static, data-free page.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
    return;
  }

  if (CACHEABLE.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const hit = await caches.match(request);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
  // Everything else (HTML, /api/*, etc.): passthrough, never cached.
});
