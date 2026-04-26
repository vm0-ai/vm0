// Service worker for Web Push Notifications and offline caching.
// Push handling based on https://github.com/pirminrehm/service-worker-web-push-example

// Per-deployment cache names: each SW update creates new caches, and the
// activate handler deletes old ones, preventing unbounded growth from
// content-hashed assets piling up across deploys.
const CACHE_VERSION = String(Date.now());
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const PAGES_CACHE = `pages-${CACHE_VERSION}`;

const STATIC_RE =
  /\.(?:js|css|png|svg|jpe?g|gif|ico|woff2?|ttf|eot|webp|avif|json|wasm|map)$/i;

function isNavigation(r) {
  return r.mode === "navigate";
}

function isStaticAsset(url) {
  return url.origin === self.location.origin && STATIC_RE.test(url.pathname);
}

function isApiRequest(url) {
  return (
    url.origin === self.location.origin && url.pathname.startsWith("/api/")
  );
}

function timeout(ms) {
  return new Promise((_resolve, reject) =>
    self.setTimeout(() => reject(new Error("timeout")), ms),
  );
}

// Install: precache offline page for navigation fallback
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PAGES_CACHE).then((c) => c.add("/offline.html")));
  self.skipWaiting();
});

// Activate: delete old cache versions, then claim all clients
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== PAGES_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: layered caching strategy
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  if (isNavigation(event.request)) {
    // Network-First with 5s timeout, fallback to offline page.
    // URL bar keeps the original URL — a reload recovers to this location.
    event.respondWith(
      Promise.race([fetch(event.request), timeout(5000)]).catch(() =>
        caches.match("/offline.html"),
      ),
    );
    return;
  }

  if (isStaticAsset(url)) {
    // Cache-First: Vite content-hashed filenames are immutable.
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request);
        if (cached) {
          return cached;
        }
        const r = await fetch(event.request);
        const clone = r.clone();
        const cache = await caches.open(STATIC_CACHE);
        await cache.put(event.request, clone);
        return r;
      })(),
    );
    return;
  }

  if (isApiRequest(url)) {
    // API: network only, no caching.
    event.respondWith(fetch(event.request));
    return;
  }

  // Other requests (third-party, etc.): network only.
  event.respondWith(fetch(event.request));
});

// --- Web Push Notifications (unchanged) ---

self.addEventListener("push", (event) => {
  const data = event.data?.json() ?? {};

  const options = {
    body: data.body ?? "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url },
  };

  event.waitUntil(
    self.registration.showNotification(data.title ?? "vm0", options),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Reuse an existing same-origin tab: postMessage lets the SPA
        // router navigate without a full page reload.
        for (const client of windowClients) {
          if ("focus" in client) {
            client.postMessage({ type: "NOTIFICATION_CLICK", url });
            return client.focus();
          }
        }
        return clients.openWindow(url);
      }),
  );
});
