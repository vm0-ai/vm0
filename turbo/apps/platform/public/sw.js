const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai", "okou-app.pages.dev"];

function defaultNotificationTitle() {
  const hostname = self.location.hostname.toLowerCase();
  const isOkou = OKOU_ROOT_DOMAINS.some((domain) => {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
  return isOkou ? "Okou" : "VM0";
}

self.addEventListener("install", (_event) => {
  self.skipWaiting();
});

// --- Web Push Notifications ---

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { body: event.data.text() };
    }
  }

  const options = {
    body: data.body ?? "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url },
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title ?? defaultNotificationTitle(),
      options,
    ),
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
