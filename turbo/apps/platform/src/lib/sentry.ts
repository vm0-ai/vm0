import * as Sentry from "@sentry/react";

// Initialize Sentry synchronously so that global error/unhandledrejection
// handlers are installed before the app bootstraps. Errors during bootstrap
// (route resolution, signal evaluation) would be missed with deferred init.
export function initSentry(): void {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,

    // Only enable when DSN is configured
    enabled: !!import.meta.env.VITE_SENTRY_DSN,

    // Set environment (Vercel provides VITE_VERCEL_ENV in builds)
    environment: import.meta.env.VITE_VERCEL_ENV,

    // Set app tag to identify this app in Sentry
    initialScope: {
      tags: {
        app: "platform",
      },
    },

    // Disable tracing - only error tracking is needed
    tracesSampleRate: 0,

    // Filter out expected errors
    beforeSend(event) {
      // Filter out 4xx client errors that are expected
      const statusCode = event.contexts?.response?.status_code;
      if (
        typeof statusCode === "number" &&
        statusCode >= 400 &&
        statusCode < 500
      ) {
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
    ],
  });
}

export function setSentryUser(userId: string) {
  Sentry.setUser({ id: userId });
}

export function clearSentryUser() {
  Sentry.setUser(null);
}

export { Sentry };
