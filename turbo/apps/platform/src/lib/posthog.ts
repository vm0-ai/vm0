import posthog from "posthog-js";

let enabled = false;

export function initPostHog(): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key) return;

  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string) || "https://us.posthog.com";

  try {
    posthog.init(key, {
      api_host: host,
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

export function isPostHogEnabled(): boolean {
  return enabled;
}

export function setPostHogUser(userId: string): void {
  if (!enabled) return;
  posthog.identify(userId);
}

export function clearPostHogUser(): void {
  if (!enabled) return;
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
  renderTime?: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

let active: NavigationTiming | null = null;

export function startChatNavigationTiming(): void {
  if (!enabled) return;
  const enterTime = performance.now();
  active = {
    enterTime,
    timeoutId: setTimeout(() => {
      if (active?.enterTime === enterTime) {
        active = null;
      }
    }, 30_000),
  };
}

export function markNavigationPushState(): void {
  if (!enabled || !active) return;
  active.pushStateTime = performance.now();
}

export function markRouteSetupBegin(): void {
  if (!enabled || !active) return;
  active.routeSetupTime = performance.now();
}

export function markRenderComplete(): void {
  if (!enabled || !active) return;

  // React StrictMode fires effects twice in development. After the first
  // capture we null the slot so the second invocation is a no-op.
  const t = active;
  active = null;
  clearTimeout(t.timeoutId);

  t.renderTime = performance.now();

  posthog.capture("chat_navigation_performance", {
    total_ms: t.renderTime - t.enterTime,
    enter_to_pushstate_ms: t.pushStateTime
      ? t.pushStateTime - t.enterTime
      : null,
    pushstate_to_setup_ms:
      t.pushStateTime && t.routeSetupTime
        ? t.routeSetupTime - t.pushStateTime
        : null,
    setup_to_render_ms: t.routeSetupTime
      ? t.renderTime - t.routeSetupTime
      : null,
    is_new_thread: true,
  });
}

export { posthog };
