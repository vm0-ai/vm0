import { isDesktopAuthFlow } from "./desktop-auth-flow.ts";
import * as Sentry from "@sentry/browser";
import type { BrowserOptions, Contexts, User } from "@sentry/browser";

import { setLogErrorHandler } from "../signals/log.ts";
import { ApiError } from "./api-error.ts";
import { resolvePlatformRuntimeConfig } from "./platform-host.ts";

type PlatformSentryRuntime = "page" | "shared-worker";

type SentryTags = Parameters<typeof Sentry.setTags>[0];

interface SentryLoggerContext {
  readonly contexts?: Contexts;
  readonly tags?: SentryTags;
  readonly user?: User;
}

const SENTRY_LOG_CONTEXT = Symbol("vm0.sentry-log-context");

interface SentryLogContextArgument {
  readonly [SENTRY_LOG_CONTEXT]: SentryLoggerContext;
}

function isSentryLogContextArgument(
  value: unknown,
): value is SentryLogContextArgument {
  return (
    typeof value === "object" && value !== null && SENTRY_LOG_CONTEXT in value
  );
}

export function sentryLogContext(
  context: SentryLoggerContext,
): SentryLogContextArgument {
  return { [SENTRY_LOG_CONTEXT]: context };
}

export function createPlatformSentryOptions(
  runtime: PlatformSentryRuntime,
): BrowserOptions {
  const runtimeConfig = resolvePlatformRuntimeConfig();

  return {
    dsn: runtimeConfig.sentryDsn ?? undefined,

    // Production telemetry values are present in every build but are only
    // enabled when the serving domain resolves to the production environment.
    enabled: runtimeConfig.sentryDsn !== null,

    environment: runtimeConfig.environment,

    initialScope: {
      tags: {
        app: "platform",
        public_brand: runtimeConfig.publicBrand,
        ...(runtime === "shared-worker"
          ? { runtime: "shared-worker", worker: "shared-database" }
          : {}),
      },
    },

    // Disable tracing - only error tracking is needed
    tracesSampleRate: 0,

    // Preserve native fetch errors for application-level error handling.
    enhanceFetchErrorMessages: false,

    beforeBreadcrumb(breadcrumb) {
      if (runtime === "page" && isDesktopAuthFlow()) {
        return null;
      }
      return runtime === "shared-worker" && breadcrumb.category === "console"
        ? null
        : breadcrumb;
    },

    // Filter out expected errors
    beforeSend(event, hint) {
      if (runtime === "page" && isDesktopAuthFlow()) {
        return null;
      }
      // Filter out 4xx client errors that are expected
      const statusCode = event.contexts?.response?.status_code;
      if (
        typeof statusCode === "number" &&
        statusCode >= 400 &&
        statusCode < 500
      ) {
        return null;
      }

      // ApiError thrown by accept() — surfaced through toast notifications and
      // not actionable in Sentry.
      const original = hint?.originalException;
      if (original instanceof ApiError) {
        return null;
      }

      return event;
    },

    // Ignore common client-side errors
    ignoreErrors: [
      // Network errors
      "Failed to fetch",
      "NetworkError",
      "Load failed",
      // User navigation
      "AbortError",
      // Browser extensions
      "ResizeObserver loop",
      // Clerk SDK - session cleared by Mobile Safari ITP (third-party noise)
      "Unable to authenticate the request",
      // Expected authentication failures surfaced to the request caller.
      "Not authenticated",
      "Authentication required",
      // 404 for stale agent references (deleted agents, cross-org bookmarks,
      // pinned IDs that no longer resolve). Surfaced to users as a toast and
      // not actionable in Sentry.
      "Agent not found",
      // Expected API errors surfaced as toasts — not actionable in Sentry
      "Credits depleted",
      "Insufficient credits",
      // Third-party scripts (we don't use axios — any AxiosError is external noise)
      "AxiosError",
      // Ably SDK internal rejections — when the WebSocket connection closes
      // during an in-flight channel attach, Ably's internal promises reject
      // before our try/catch in realtime.ts can suppress them.
      "Connection closed",
    ],

    // Filter out errors from browser extension and third-party scripts
    denyUrls: [
      /inpage\.js/,
      /chrome-extension:\/\//,
      /moz-extension:\/\//,
      // Termly compliance/cookie consent script
      /app\.termly\.io/,
      /resource-blocker/,
    ],
  };
}

export function captureSentryLogError(
  loggerName: string,
  args: unknown[],
): void {
  const contextArgument = args.find(isSentryLogContextArgument);
  const context = contextArgument?.[SENTRY_LOG_CONTEXT];
  const captureContext = {
    ...context,
    tags: { ...context?.tags, logger: loggerName },
  };
  const capturedArgs = args.filter((arg) => {
    return !isSentryLogContextArgument(arg);
  });
  const error = capturedArgs.find((arg): arg is Error => {
    return arg instanceof Error;
  });
  if (error) {
    Sentry.captureException(error, captureContext);
    return;
  }
  Sentry.captureMessage(capturedArgs.map(String).join(" "), {
    ...captureContext,
    level: "error",
  });
}

export function setupSentryLogger(): void {
  setLogErrorHandler(captureSentryLogError);
}
