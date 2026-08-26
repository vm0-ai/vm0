import { command, state } from "ccstate";
import { posthog, type CaptureResult } from "posthog-js";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

const RUNTIME_CONFIG = resolvePlatformRuntimeConfig();
const POSTHOG_KEY = RUNTIME_CONFIG.postHogKey;

export const AUTH_V2_DIAGNOSTIC_EVENT = "auth_v2_diagnostic";
const AUTH_V2_DIAGNOSTIC_DISTINCT_ID = "auth-v2";

export type AuthV2DiagnosticFlow = "sign-in" | "sign-up" | "unknown";

export type AuthV2DiagnosticMethod =
  | "apple-oauth"
  | "email-code"
  | "google-oauth"
  | "google-one-tap"
  | "identifier"
  | "organization"
  | "passkey"
  | "password"
  | "password-reset"
  | "session"
  | "unknown";

export type AuthV2DiagnosticStep =
  | "choose-factor"
  | "choose-organization"
  | "choose-session"
  | "details"
  | "email-code"
  | "identifier"
  | "initialize"
  | "new-password"
  | "oauth-callback"
  | "password"
  | "password-reset-code"
  | "recovery"
  | "restart"
  | "unknown";

export type AuthV2DiagnosticOutcome = "failure" | "success" | "unknown";

export type AuthV2DiagnosticErrorCategory =
  | "cancelled"
  | "captcha"
  | "configuration"
  | "invalid-code"
  | "invalid-credentials"
  | "invalid-input"
  | "method-unavailable"
  | "none"
  | "organization-unavailable"
  | "provider-error"
  | "session-unavailable"
  | "unknown"
  | "unsupported-state";

export interface AuthV2DiagnosticProperties {
  readonly error_category: AuthV2DiagnosticErrorCategory;
  readonly flow: AuthV2DiagnosticFlow;
  readonly method: AuthV2DiagnosticMethod;
  readonly outcome: AuthV2DiagnosticOutcome;
  readonly step: AuthV2DiagnosticStep;
}

function authV2DiagnosticFlow(value: unknown): AuthV2DiagnosticFlow {
  switch (value) {
    case "sign-in":
    case "sign-up":
    case "unknown": {
      return value;
    }
    default: {
      return "unknown";
    }
  }
}

function authV2DiagnosticMethod(value: unknown): AuthV2DiagnosticMethod {
  switch (value) {
    case "apple-oauth":
    case "email-code":
    case "google-oauth":
    case "google-one-tap":
    case "identifier":
    case "organization":
    case "passkey":
    case "password":
    case "password-reset":
    case "session":
    case "unknown": {
      return value;
    }
    default: {
      return "unknown";
    }
  }
}

function authV2DiagnosticStep(value: unknown): AuthV2DiagnosticStep {
  switch (value) {
    case "choose-factor":
    case "choose-organization":
    case "choose-session":
    case "details":
    case "email-code":
    case "identifier":
    case "initialize":
    case "new-password":
    case "oauth-callback":
    case "password":
    case "password-reset-code":
    case "recovery":
    case "restart":
    case "unknown": {
      return value;
    }
    default: {
      return "unknown";
    }
  }
}

function authV2DiagnosticOutcome(value: unknown): AuthV2DiagnosticOutcome {
  switch (value) {
    case "failure":
    case "success":
    case "unknown": {
      return value;
    }
    default: {
      return "unknown";
    }
  }
}

function authV2DiagnosticErrorCategory(
  value: unknown,
): AuthV2DiagnosticErrorCategory {
  switch (value) {
    case "cancelled":
    case "captcha":
    case "configuration":
    case "invalid-code":
    case "invalid-credentials":
    case "invalid-input":
    case "method-unavailable":
    case "none":
    case "organization-unavailable":
    case "provider-error":
    case "session-unavailable":
    case "unknown":
    case "unsupported-state": {
      return value;
    }
    default: {
      return "unknown";
    }
  }
}

function sanitizePostHogCaptureResult(
  captureResult: CaptureResult | null,
): CaptureResult | null {
  if (
    captureResult === null ||
    captureResult.event !== AUTH_V2_DIAGNOSTIC_EVENT
  ) {
    return captureResult;
  }
  const properties = captureResult.properties;
  return {
    event: AUTH_V2_DIAGNOSTIC_EVENT,
    properties: {
      $process_person_profile: false,
      distinct_id: AUTH_V2_DIAGNOSTIC_DISTINCT_ID,
      error_category: authV2DiagnosticErrorCategory(properties.error_category),
      flow: authV2DiagnosticFlow(properties.flow),
      method: authV2DiagnosticMethod(properties.method),
      outcome: authV2DiagnosticOutcome(properties.outcome),
      step: authV2DiagnosticStep(properties.step),
      token: POSTHOG_KEY,
    },
    ...(captureResult.timestamp ? { timestamp: captureResult.timestamp } : {}),
    uuid: captureResult.uuid,
  };
}

function runPostHog(action: (key: string) => void): void {
  if (!POSTHOG_KEY) {
    return;
  }
  action(POSTHOG_KEY);
}

export function initPostHog(): void {
  runPostHog((key) => {
    posthog.init(key, {
      // First-party reverse proxy (Cloudflare-fronted): forwards /static assets,
      // /flags, ingest and replay (/s) to PostHog US so ad blockers do not drop
      // events. Shared with so.vm0.ai for one ingest domain.
      api_host: "https://j.vm0.ai",
      ui_host: "https://us.posthog.com",
      autocapture: false,
      capture_pageview: false,
      before_send: sanitizePostHogCaptureResult,
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
        return { ...properties, public_brand: RUNTIME_CONFIG.publicBrand };
      },
    });
  });
}

interface PostHogUser {
  id: string;
  email: string | undefined;
  name: string | undefined;
}

export function setPostHogUser(user: PostHogUser): void {
  runPostHog(() => {
    posthog.identify(user.id, { email: user.email, name: user.name });
  });
}

/**
 * Register first-touch acquisition fields as super properties so product
 * events, including task completion, retain the campaign and ad group that
 * brought the user into the app.
 */
export function registerPostHogAttribution(
  properties: Record<string, string>,
): void {
  runPostHog(() => {
    posthog.register(properties);
  });
}

/** Keep product events joinable to the billing organization. */
export function setPostHogOrganization(orgId: string | undefined): void {
  runPostHog(() => {
    if (orgId) {
      posthog.register({ org_id: orgId });
    } else {
      posthog.unregister("org_id");
    }
  });
}

export function clearPostHogUser(): void {
  runPostHog(() => {
    posthog.reset();
  });
}

export function captureTaskCompletedSuccessfully(): void {
  runPostHog(() => {
    posthog.capture("task_completed_successfully", { surface: "chat_thread" });
  });
}

export type ChatThreadMetadataShortcutOutcome =
  | "hit"
  | "older-payload"
  | "not-found"
  | "transport-failure";

export const captureChatThreadMetadataShortcut$ = command(
  (_, outcome: ChatThreadMetadataShortcutOutcome): void => {
    runPostHog(() => {
      posthog.capture("chat_thread_metadata_shortcut", { outcome });
    });
  },
);

export function captureAuthV2DiagnosticEvent(
  properties: AuthV2DiagnosticProperties,
): void {
  runPostHog(() => {
    posthog.capture(AUTH_V2_DIAGNOSTIC_EVENT, {
      error_category: properties.error_category,
      flow: properties.flow,
      method: properties.method,
      outcome: properties.outcome,
      step: properties.step,
    });
  });
}

/**
 * Paid-onboarding funnel events. The `PaidOnboarding: ` prefix is load-bearing:
 * the acquisition dashboards and Google Ads reconciliation both key off it.
 */
export function capturePaidOnboardingEvent(
  name: string,
  properties: Record<string, string | number | boolean>,
): void {
  runPostHog(() => {
    posthog.capture(`PaidOnboarding: ${name}`, properties);
  });
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
  runPostHog(() => {
    set(navigationEnterTime$, performance.now());
    set(navigationPushStateTime$, null);
    set(navigationSetupTime$, null);
  });
});

export const markNavigationPushState$ = command(({ get, set }) => {
  if (get(navigationEnterTime$) === null) {
    return;
  }
  runPostHog(() => {
    set(navigationPushStateTime$, performance.now());
  });
});

export const markRouteSetupBegin$ = command(({ get, set }) => {
  if (get(navigationEnterTime$) === null) {
    return;
  }
  runPostHog(() => {
    set(navigationSetupTime$, performance.now());
  });
});

export const captureNavigationTiming$ = command(({ get, set }) => {
  const enterTime = get(navigationEnterTime$);
  if (enterTime === null) {
    return;
  }
  runPostHog(() => {
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
});

export function capturePageView(): void {
  runPostHog(() => {
    posthog.capture("$pageview");
  });
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

  runPostHog(() => {
    const startMark = window.__appBootstrapStart;
    if (typeof startMark !== "number") {
      return;
    }
    posthog.capture("app_first_skeleton_hide", {
      duration_ms: Math.round(performance.now() - startMark),
    });
  });
});

interface RecommendedFollowupTelemetryItem {
  readonly kind: string;
  readonly generationType?: string;
}

function recommendedFollowupGenerationTypes(
  followups: readonly RecommendedFollowupTelemetryItem[],
): string[] {
  return followups.flatMap((followup) => {
    return followup.generationType ? [followup.generationType] : [];
  });
}

export function captureRecommendedFollowupsShown(args: {
  readonly messageId: string;
  readonly followups: readonly RecommendedFollowupTelemetryItem[];
}): void {
  runPostHog(() => {
    posthog.capture("chat_recommended_followups_shown", {
      assistant_message_id: args.messageId,
      followup_count: args.followups.length,
      followup_kinds: args.followups.map((followup) => {
        return followup.kind;
      }),
      generation_types: recommendedFollowupGenerationTypes(args.followups),
    });
  });
}

export function captureRecommendedFollowupSelected(args: {
  readonly messageId: string;
  readonly followupIndex: number;
  readonly followupCount: number;
  readonly followup: RecommendedFollowupTelemetryItem;
}): void {
  runPostHog(() => {
    posthog.capture("chat_recommended_followup_selected", {
      assistant_message_id: args.messageId,
      followup_index: args.followupIndex,
      followup_count: args.followupCount,
      followup_kind: args.followup.kind,
      generation_type: args.followup.generationType,
    });
  });
}
