import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN_WEB,

  // Only enable in production (exclude Vercel preview deployments)
  enabled: process.env.VERCEL_ENV === "production",

  // Set environment (Vercel provides VERCEL_ENV)
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,

  // Set app tag to identify this app in Sentry
  initialScope: {
    tags: {
      app: "web",
    },
  },

  // Disable tracing - only error tracking is needed
  tracesSampleRate: 0,
});
