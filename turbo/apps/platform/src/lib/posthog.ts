import { posthog } from "posthog-js";
import { timeout } from "signal-timers";

let enabled = false;

export function initPostHog(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) {
    return;
  }

  try {
    posthog.init(key, {
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
    enabled = true;
  } catch {
    // Ad blockers or network failures may prevent PostHog from loading.
    // Fail silently — the timing API functions below are no-ops when disabled.
  }
}

export function setPostHogUser(userId: string): void {
  if (!enabled) {
    return;
  }
  posthog.identify(userId);
}

export function clearPostHogUser(): void {
  if (!enabled) {
    return;
  }
  posthog.reset();
}

// ── Navigation timing API ────────────────────────────────────────────
//
// A single module-level slot avoids threading timing state through the
// signal graph. Only one user-initiated navigation can be in-flight at
// a time, so a plain variable suffices.

interface NavigationTiming {
  enterTime: number;
  pushStateTime?: number;
  routeSetupTime?: number;
  timeoutController: AbortController;
}

let active: NavigationTiming | null = null;

export function startChatNavigationTiming(): void {
  if (!enabled) {
    return;
  }
  const enterTime = performance.now();
  const timeoutController = new AbortController();
  active = {
    enterTime,
    timeoutController,
  };
  timeout(
    () => {
      if (active?.enterTime === enterTime) {
        active = null;
      }
    },
    30_000,
    { signal: timeoutController.signal },
  );
}

export function markNavigationPushState(): void {
  if (!enabled || !active) {
    return;
  }
  active.pushStateTime = performance.now();
}

export function markRouteSetupBegin(): void {
  if (!enabled || !active) {
    return;
  }
  active.routeSetupTime = performance.now();
}
