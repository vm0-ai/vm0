import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  navigateInReact$,
  setupAuthPageWrapper,
} from "./route.ts";
import { logger } from "./log.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupZeroPage$ } from "./zero-page/zero-page.ts";
import { setupZeroJobDetailRoute$ } from "./zero-page/zero-job-detail-route.ts";
import { setupSelectOrgPage$ } from "./select-org/select-org-page.ts";

const L = logger("Bootstrap");

const setupHomeRedirect$ = command(({ set }) => {
  L.debug("redirecting / to /zero");
  set(navigateInReact$, "/zero");
});

const ROUTE_CONFIG = [
  {
    path: "/",
    setup: setupAuthPageWrapper(setupHomeRedirect$),
  },
  {
    path: "/select-org",
    setup: setupAuthPageWrapper(setupSelectOrgPage$),
  },
  {
    path: "/zero/chat/:sessionId",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/zero/team/:name",
    setup: setupAuthPageWrapper(setupZeroJobDetailRoute$),
  },
  {
    path: "/zero/:tab/:sub",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/zero/:tab",
    setup: setupAuthPageWrapper(setupZeroPage$),
  },
  {
    path: "/zero",
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
