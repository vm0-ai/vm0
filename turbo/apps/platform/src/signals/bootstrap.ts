import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import { initRoutes$, setupAuthPageWrapper } from "./route.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupZeroPage$ } from "./zero-page/zero-page.ts";
import { setupZeroJobDetailRoute$ } from "./zero-page/zero-job-detail-route.ts";
import { setupSelectOrgPage$ } from "./select-org/select-org-page.ts";
import { setupSlackConnectPage$ } from "./zero-page/slack-connect-page.ts";
const ROUTE_CONFIG = [
  {
    path: "/select-org",
    setup: setupAuthPageWrapper(setupSelectOrgPage$),
  },
  {
    path: "/chat/:sessionId",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/talk/:name",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/team/:name",
    setup: setupAuthPageWrapper(setupZeroJobDetailRoute$),
  },
  {
    path: "/slack/connect",
    setup: setupAuthPageWrapper(setupSlackConnectPage$),
  },
  {
    path: "/queue",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/:tab/:sub",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/:tab",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(setRootSignal$, signal);

    set(setupLoggers$);

    render();

    await Promise.all([
      set(setupGlobalMethod$, signal),
      set(setupClerk$, signal),
      set(setupRoutes$, signal),
    ]);
    signal.throwIfAborted();
  },
);
