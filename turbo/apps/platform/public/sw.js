// Service worker for Web Push Notifications
// Based on https://github.com/pirminrehm/service-worker-web-push-example

self.addEventListener("install", () => {
  self.skipWaiting();
});

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
          if (new URL(client.url).pathname === url && "focus" in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      }),
  );
});
