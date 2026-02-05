import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,

  // Only enable in production
  enabled: process.env.NODE_ENV === "production",

  // Set environment (Vercel provides VERCEL_ENV)
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,

  // Set app tag to distinguish from platform app
  initialScope: {
    tags: {
      app: "web",
    },
  },

  // Disable tracing - only error tracking is needed
  tracesSampleRate: 0,
});
