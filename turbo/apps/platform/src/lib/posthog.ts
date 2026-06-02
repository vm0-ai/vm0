import { command, state } from "ccstate";
import { posthog } from "posthog-js";

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;

export function initPostHog(): void {
  if (!POSTHOG_KEY) {
    return;
  }

  posthog.init(POSTHOG_KEY, {
    // First-party reverse proxy (Cloudflare-fronted): forwards /static assets,
    // /flags, ingest and replay (/s) to PostHog US so ad blockers do not drop
    // events. Shared with so.vm0.ai for one ingest domain. The legacy /ingest
    // vercel.json rewrite is now unused (kept as fallback for now).
    api_host: "https://j.vm0.ai",
    ui_host: "https://us.posthog.com",
    autocapture: false,
    capture_pageview: false,
    // Replay is off app-wide; it is enabled only for scoped flows (currently
    // onboarding) via startOnboardingSessionRecording(). When it runs, this
    // config masks all inputs and text so we capture behavior, not content.
    disable_session_recording: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
    },
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

interface PostHogUser {
  id: string;
  email: string | undefined;
  name: string | undefined;
}

export function setPostHogUser(user: PostHogUser): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.identify(user.id, { email: user.email, name: user.name });
}

export function clearPostHogUser(): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.reset();
}

// ── Scoped session replay ──────────────────────────────────────────
//
// Replay is disabled at init (see initPostHog). These helpers turn it on for a
// single flow — currently onboarding — so we can see where new users drop off
// without recording the entire app. Inputs and text are masked (see the
// session_recording config), so replays show behavior, not content. The
// onboarding route setup starts recording on enter and stops it on unmount.

export function startOnboardingSessionRecording(): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.startSessionRecording();
}

export function stopOnboardingSessionRecording(): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.stopSessionRecording();
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

export const captureNavigationTiming$ = command(({ get, set }) => {
  const enterTime = get(navigationEnterTime$);
  if (!POSTHOG_KEY || enterTime === null) {
    return;
  }
  const now = performance.now();
  const pushStateTime = get(navigationPushStateTime$);
  const setupTime = get(navigationSetupTime$);
  posthog.capture("chat_navigation_timing", {
    total_ms: Math.round(now - enterTime),
    push_state_ms:
      pushStateTime !== null
        ? Math.round(pushStateTime - enterTime)
        : undefined,
    setup_begin_ms:
      setupTime !== null ? Math.round(setupTime - enterTime) : undefined,
  });
  set(navigationEnterTime$, null);
  set(navigationPushStateTime$, null);
  set(navigationSetupTime$, null);
});

export function capturePageView(): void {
  if (!POSTHOG_KEY) {
    return;
  }
  posthog.capture("$pageview");
}

const firstSkeletonHideReported$ = state(false);

/**
 * Report the time elapsed from the inline `__appBootstrapStart` mark in
 * `index.html` to the first `hideAppSkeleton$` invocation. Captures the
 * total perceived bootstrap duration (HTML parse start → first real content).
 * No-op after the first call.
 */
export const captureFirstSkeletonHide$ = command(({ get, set }) => {
  if (get(firstSkeletonHideReported$)) {
    return;
  }
  set(firstSkeletonHideReported$, true);

  if (!POSTHOG_KEY) {
    return;
  }
  const startMark = window.__appBootstrapStart;
  if (typeof startMark !== "number") {
    return;
  }
  posthog.capture("app_first_skeleton_hide", {
    duration_ms: Math.round(performance.now() - startMark),
  });
});
