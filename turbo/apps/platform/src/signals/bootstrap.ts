import { command, type Command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  navigateInReact$,
  setupAuthPageWrapper,
} from "./route.ts";
import { setupHomePage$ } from "./home/home-page.ts";
import { setupLogsPage$ } from "./logs-page/logs-page.ts";
import { hasScope$ } from "./scope.ts";
import { logger } from "./log.ts";
import { setupGlobalMethod$ } from "./bootstrap/global-method.ts";
import { setupLoggers$ } from "./bootstrap/loggers.ts";

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
] as const;

const setupRoutes$ = command(async ({ set }, signal: AbortSignal) => {
  await set(initRoutes$, ROUTE_CONFIG, signal);
});

export const bootstrap$ = command(
  async ({ set }, render: () => void, signal: AbortSignal) => {
    set(setRootSignal$, signal);

    set(setupLoggers$);
    set(setupGlobalMethod$, signal);

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

      const scopeExists = await get(hasScope$);
      signal.throwIfAborted();
      L.debug("scopeExists", scopeExists);

      if (!scopeExists) {
        L.debug("redirect to homepage because scope does not exist");
        set(navigateInReact$, "/");
        return;
      }

      await set(fn, signal);
      signal.throwIfAborted();
    }),
  );
}
