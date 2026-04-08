/**
 * Web Push notification helpers for the platform PWA.
 *
 * - registerServiceWorker() — called once on app startup
 * - ensurePushSubscription() — fire-and-forget on each send
 */

import { state } from "ccstate";
import { appStore } from "../signals/app-store.ts";
import { clerk$ } from "../signals/auth.ts";
import { apiBase$ } from "../signals/fetch.ts";

const swRegistration$ = state<ServiceWorkerRegistration | null>(null);
const subscribing$ = state(false);

/**
 * Register the service worker. Safe to call multiple times.
 * Returns null if push is not supported in this browser.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return null;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");
  appStore.set(swRegistration$, registration);
  return registration;
}

/**
 * Ensure the user has an active push subscription.
 *
 * If permission is "default", requests it. If granted, subscribes and
 * sends the subscription to the backend. Silently no-ops on denial or
 * when push is unsupported.
 *
 * This is fire-and-forget — callers should NOT await it.
 */
export function ensurePushSubscription(): void {
  if (appStore.get(subscribing$)) {
    return;
  }
  const registration = appStore.get(swRegistration$);
  if (!registration) {
    return;
  }
  appStore.set(subscribing$, true);
  function resetFlag() {
    appStore.set(subscribing$, false);
  }
  doSubscribe(registration).then(resetFlag).catch(resetFlag);
}

async function doSubscribe(
  registration: ServiceWorkerRegistration,
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
    if (result !== "granted") {
      return;
    }
  }

  if (Notification.permission !== "granted") {
    return;
  }

  // Check if already subscribed
  const existingSub = await registration.pushManager.getSubscription();
  if (existingSub) {
    return;
  }

  // Subscribe with VAPID key
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      .buffer as ArrayBuffer,
  });

  // Send subscription to backend
  const clerk = await appStore.get(clerk$);
  const token = await clerk.session?.getToken();
  const apiBase = appStore.get(apiBase$);

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
