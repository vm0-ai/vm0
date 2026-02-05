import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === "production",

  // Set environment (Vercel provides NEXT_PUBLIC_VERCEL_ENV)
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,

  // Set app tag to distinguish from platform app
  initialScope: {
    tags: {
      app: "web",
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
