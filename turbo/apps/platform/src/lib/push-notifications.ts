/**
 * Web Push notification signals for the platform PWA.
 *
 * - registerServiceWorker$ — called once on app startup
 * - ensurePushSubscription$ — fire-and-forget on each send
 */

import { command, state } from "ccstate";
import { pwaOfflineCacheEnabled$ } from "../signals/external/feature-switch.ts";
import { clerk$ } from "../signals/auth.ts";
import { apiBase$ } from "../signals/fetch.ts";

const swRegistration$ = state<ServiceWorkerRegistration | null>(null);
const subscribing$ = state(false);

/**
 * Register the service worker. Safe to call multiple times.
 * No-ops if push is not supported in this browser.
 */
export const registerServiceWorker$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return;
    }

    // Registration can reject for reasons outside our control: private
    // browsing, enterprise/browser policy, user-disabled SW, etc. Push
    // notifications are a non-critical enhancement, so swallow the
    // rejection to avoid aborting bootstrap or spamming Sentry.
    const pwaOfflineEnabled = await get(pwaOfflineCacheEnabled$);
    signal.throwIfAborted();
    const registration = await navigator.serviceWorker
      .register(
        "/sw.js",
        pwaOfflineEnabled ? { updateViaCache: "none" } : undefined,
      )
      .catch(() => {
        return null;
      });
    signal.throwIfAborted();
    if (!registration) {
      return;
    }
    set(swRegistration$, registration);
  },
);

/**
 * Ensure the user has an active push subscription.
 *
 * If permission is "default", requests it. If granted, subscribes and
 * sends the subscription to the backend. Silently no-ops on denial or
 * when push is unsupported. Callers are responsible for detaching the
 * returned promise (e.g. `detach(ensurePushSubscription(pageSignal),
 * Reason.DomCallback)` from a DOM handler).
 */
export const ensurePushSubscription$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (get(subscribing$)) {
      return;
    }
    const registration = get(swRegistration$);
    if (!registration) {
      return;
    }
    set(subscribing$, true);
    // eslint-disable-next-line no-restricted-syntax -- finally needed to reset `subscribing$` on success, failure, or abort so the next call can proceed
    try {
      const clerkPromise = get(clerk$);
      const apiBase = await get(apiBase$);
      signal.throwIfAborted();
      await doSubscribe(registration, clerkPromise, apiBase, signal);
      signal.throwIfAborted();
    } finally {
      set(subscribing$, false);
    }
  },
);

async function doSubscribe(
  registration: ServiceWorkerRegistration,
  clerkPromise: Promise<{
    session?: { getToken(): Promise<string | null> } | null;
  }>,
  apiBase: string,
  signal: AbortSignal,
): Promise<void> {
  const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as
    | string
    | undefined;
  if (!vapidPublicKey) {
    return;
  }

  // Only prompt if user hasn't decided yet
  if (Notification.permission === "default") {
    const result = await Notification.requestPermission();
    signal.throwIfAborted();
    if (result !== "granted") {
      return;
    }
  }

  if (Notification.permission !== "granted") {
    return;
  }

  // Check if already subscribed
  const existingSub = await registration.pushManager.getSubscription();
  signal.throwIfAborted();
  if (existingSub) {
    return;
  }

  // Subscribe with VAPID key
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      .buffer as ArrayBuffer,
  });
  signal.throwIfAborted();

  // Send subscription to backend
  const clerk = await clerkPromise;
  signal.throwIfAborted();
  const token = await clerk.session?.getToken();
  signal.throwIfAborted();

  await fetch(`${apiBase}/api/zero/push-subscriptions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: arrayBufferToBase64(subscription.getKey("p256dh")),
        auth: arrayBufferToBase64(subscription.getKey("auth")),
      },
    }),
    signal,
  });
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) {
    return "";
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
