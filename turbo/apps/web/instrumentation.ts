// Dynamic imports are required throughout this file: Next.js instrumentation
// runs in a restricted module scope before the full app bundle is loaded.
// Top-level imports from app code would cause build-time circular dependency
// errors; dynamic imports are the recommended pattern for this hook.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    // Sync skills cache on startup (only in dev — production uses cron at /api/cron/sync-skills)
    if (process.env.NODE_ENV === "development") {
      const { initServices } = await import("./src/lib/init-services");
      initServices();
      const { logger } = await import("./src/lib/shared/logger");
      const log = logger("instrumentation");
      const { syncSkills } = await import("./src/lib/zero/skills/sync-skills");
      syncSkills().catch((error: unknown) => {
        log.error("Failed to sync skills on startup", {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      // Locally emulate Vercel's cron scheduler by reading vercel.json and
      // self-fetching each cron path on schedule. Production uses Vercel's
      // managed crons — this block is dev-only.
      const { startDevCronScheduler } =
        await import("./src/lib/dev/cron-scheduler");
      const vercelConfig = await import("./vercel.json");
      startDevCronScheduler(vercelConfig.default ?? vercelConfig);
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = async (
  error: Error & { digest?: string },
  request: {
    path: string;
    method: string;
    headers: Record<string, string>;
  },
  context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "middleware";
    renderSource:
      | "react-server-components"
      | "react-server-components-payload"
      | "server-rendering";
    revalidateReason: "on-demand" | "stale" | undefined;
    renderType: "dynamic" | "dynamic-resume";
  },
) => {
  const { captureException } = await import("@sentry/nextjs");
  captureException(error, {
    extra: {
      request,
      context,
    },
  });
};
