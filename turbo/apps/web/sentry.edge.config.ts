import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === "production",

  // Set app tag to distinguish from platform app
  initialScope: {
    tags: {
      app: "web",
    },
  },

  // Disable tracing - only error tracking is needed
  tracesSampleRate: 0,
});
