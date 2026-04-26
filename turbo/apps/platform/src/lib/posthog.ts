import { command, state } from "ccstate";
import { posthog } from "posthog-js";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;

export function initPostHog(): void {
  if (!POSTHOG_KEY) {
    return;
  }

  posthog.init(POSTHOG_KEY, {
    api_host: "https://us.posthog.com",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    persistence: "localStorage+cookie",
    sanitize_properties(properties, _event) {
      if (properties?.$current_url) {
        properties["$current_url"] = properties["$current_url"].replace(
          /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          "/:id",
        );
      }
      return properties;
    },
  });
}

export function setPostHogUser(userId: string): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.identify(userId);
}

export function clearPostHogUser(): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.reset();
}

// ── Navigation timing (ccstate-based) ──────────────────────────────
//
// Timing marks are ccstate signals so they compose naturally with the
// existing signal graph. A new startChatNavigationTiming$ call
// overwrites the previous timing — no AbortController or timeout needed.

const navigationEnterTime$ = state<number | null>(null);
const navigationPushStateTime$ = state<number | null>(null);
const navigationSetupTime$ = state<number | null>(null);

export const startChatNavigationTiming$ = command(({ set }) => {
  if (!POSTHOG_KEY) {
    return;
  }
  set(navigationEnterTime$, performance.now());
  set(navigationPushStateTime$, null);
  set(navigationSetupTime$, null);
});

export const markNavigationPushState$ = command(({ get, set }) => {
  if (!POSTHOG_KEY || get(navigationEnterTime$) === null) {
    return;
  }
  set(navigationPushStateTime$, performance.now());
});

export const markRouteSetupBegin$ = command(({ get, set }) => {
  if (!POSTHOG_KEY || get(navigationEnterTime$) === null) {
    return;
  }
  set(navigationSetupTime$, performance.now());
});
