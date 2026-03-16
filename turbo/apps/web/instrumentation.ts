export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");

    // Sync skills cache on startup (needed for dev environments without Vercel cron)
    const { initServices } = await import("./src/lib/init-services");
    initServices();
    const { syncSkills } = await import("./src/lib/skills/sync-skills");
    syncSkills().catch(() => {}); // fire-and-forget, don't block startup
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
