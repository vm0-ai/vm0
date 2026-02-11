import * as Sentry from "@sentry/nextjs";
import { env } from "./src/env";

Sentry.init({
  dsn: env().SENTRY_DSN,

  // Only enable in production
  enabled: env().NODE_ENV === "production",

  // Set environment (Vercel provides VERCEL_ENV)
  environment: env().VERCEL_ENV || env().NODE_ENV,

  // Set app tag to distinguish from platform app
  initialScope: {
    tags: {
      app: "web",
    },
  },

  // Disable tracing - only error tracking is needed
  tracesSampleRate: 0,
});
