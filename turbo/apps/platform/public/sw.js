// Service worker for Web Push Notifications and offline caching.
// Push handling based on https://github.com/pirminrehm/service-worker-web-push-example

const CACHE_VERSION = "1";
const STATIC_CACHE = `static-v${CACHE_VERSION}`;
const PAGES_CACHE = `pages-v${CACHE_VERSION}`;

const STATIC_RE = /\.(?:js|css|png|svg|jpe?g|gif|ico|woff2?|ttf|eot|webp|avif|json|wasm|map)$/i;

function isNavigation(r) {
  return r.mode === "navigate";
}

function isStaticAsset(url) {
  return url.origin === self.location.origin && STATIC_RE.test(url.pathname);
}

function isApiRequest(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/api/");
}

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
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
  if (event.request.method !== "GET") return;

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
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((r) => {
        const clone = r.clone();
        caches.open(STATIC_CACHE).then((c) => c.put(event.request, clone));
        return r;
      })),
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
