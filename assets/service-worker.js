/* global self, caches, fetch */

const CACHE_NAME = "codex-web-static-v2";
const STATIC_PATH = /^\/(?:assets\/|favicon\.svg$|manifest\.json$)/;

self.addEventListener("install", () => {
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("codex-web-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never cache authenticated HTML, API calls, workspace files, or WebSocket
  // traffic. PWA caching is intentionally limited to immutable UI assets.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !STATIC_PATH.test(url.pathname)
  ) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok) {
        void cache.put(request, response.clone());
      }
      return response;
    }),
  );
});
