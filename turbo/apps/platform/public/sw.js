// Service worker for Web Push Notifications and static asset caching.

// Per-deployment cache names: each SW update creates new caches, and the
// activate handler deletes old ones, preventing unbounded growth from
// content-hashed assets piling up across deploys.
const CACHE_VERSION = String(Date.now());
const STATIC_CACHE = `static-${CACHE_VERSION}`;

const STATIC_RE =
  /\.(?:js|css|png|svg|jpe?g|gif|ico|woff2?|ttf|eot|webp|avif|json|wasm|map)$/i;

function isStaticAsset(url) {
  return url.origin === self.location.origin && STATIC_RE.test(url.pathname);
}

function isApiRequest(url) {
  return (
    url.origin === self.location.origin && url.pathname.startsWith("/api/")
  );
}

function isCacheableAssetResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  return (
    response.ok &&
    !response.redirected &&
    !contentType.toLowerCase().includes("text/html")
  );
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// Activate: delete old cache versions, then claim all clients
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Fetch: static asset caching only — navigation requests are not intercepted
// so the browser handles page loads natively without any offline fallback.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);

  if (isStaticAsset(url)) {
    // Cache-First: Vite content-hashed filenames are immutable.
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(event.request);
        if (cached && isCacheableAssetResponse(cached)) {
          return cached;
        }

        if (cached) {
          await cache.delete(event.request);
        }

        const r = await fetch(event.request, { cache: "reload" });
        if (isCacheableAssetResponse(r)) {
          await cache.put(event.request, r.clone());
        }
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

  // All other requests (navigation, third-party, etc.): pass through to
  // the browser's default handling without SW interception.
});

// --- Web Push Notifications ---

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
