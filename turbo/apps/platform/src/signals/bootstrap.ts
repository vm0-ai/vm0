import { command, type Command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  navigateInReact$,
  setupAuthPageWrapper,
  setupPageWrapper,
} from "./route.ts";
import { setupHomePage$ } from "./home/home-page.ts";
import { setupLogsPage$ } from "./logs-page/logs-page.ts";
import { setupLogDetailPage$ } from "./logs-page/log-detail-page.ts";
import { setupSettingsPage$ } from "./settings-page/settings-page.ts";
import { setupAgentsPage$ } from "./agents-page/agents-page.ts";
import { hasScope$ } from "./scope.ts";
import { logger } from "./log.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";
import { setupPlaygroundPage$ } from "./playground-page/playground-page.ts";

const L = logger("Bootstrap");

const ROUTE_CONFIG = [
  {
    path: "/",
    setup: setupAuthPageWrapper(setupHomePage$),
  },
  {
    path: "/logs",
    setup: setupScopeRequiredPageWrapper(setupLogsPage$),
  },
  {
    path: "/logs/:id",
    setup: setupScopeRequiredPageWrapper(setupLogDetailPage$),
  },
  {
    path: "/settings",
    setup: setupScopeRequiredPageWrapper(setupSettingsPage$),
  },
  {
    path: "/agents",
    setup: setupAuthPageWrapper(setupAgentsPage$),
  },
  {
    path: "/_playground",
    setup: setupPageWrapper(setupPlaygroundPage$),
  },
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(setRootSignal$, signal);

    set(setupLoggers$);
    set(setupGlobalMethod$, signal).catch(() => {
      // Global method setup runs in background, errors are non-fatal
    });

    render();

    await set(setupClerk$, signal);
    signal.throwIfAborted();

    await set(setupRoutes$, signal);
    signal.throwIfAborted();
  },
);

function setupScopeRequiredPageWrapper(
  fn: Command<Promise<void> | void, [AbortSignal]>,
) {
  return setupAuthPageWrapper(
    command(async ({ get, set }, signal: AbortSignal) => {
      L.debug("enter setupScopeRequiredPageWrapper");

      // First, immediately render the page to provide instant visual feedback
      // The page components will show loading skeletons while data fetches
      await set(fn, signal);
      signal.throwIfAborted();

      // Then check scope in background (after page is already displayed)
      const scopeExists = await get(hasScope$);
      signal.throwIfAborted();
      L.debug("scopeExists", scopeExists);

      if (!scopeExists) {
        L.debug("redirect to homepage because scope does not exist");
        set(navigateInReact$, "/");
        return;
      }
    }),
  );
}
