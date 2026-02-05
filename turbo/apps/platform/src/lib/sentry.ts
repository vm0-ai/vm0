import * as Sentry from "@sentry/react";

// Initialize Sentry immediately on import
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,

  // Only enable in production
  enabled: import.meta.env.PROD,

  // Set environment (Vercel provides VITE_VERCEL_ENV in builds)
  environment: import.meta.env.VITE_VERCEL_ENV || import.meta.env.MODE,

  // Set app tag to distinguish from web app
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
  ],
});

export function setSentryUser(userId: string) {
  Sentry.setUser({ id: userId });
}

export function clearSentryUser() {
  Sentry.setUser(null);
}

export { Sentry };
