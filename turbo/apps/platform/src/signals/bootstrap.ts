import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import {
  initRoutes$,
  setupAuthPageWrapper,
  setupScopeRequiredPageWrapper,
} from "./route.ts";
import { setupHomePage$ } from "./home/home-page.ts";
import { setupLogsPage$ } from "./logs-page/logs-page.ts";
import { setupOnboardingPage$ } from "./onboarding/onboarding-page.ts";

const ROUTE_CONFIG = [
  {
    path: "/onboarding",
    setup: setupAuthPageWrapper(setupOnboardingPage$),
  },
  {
    path: "/",
    setup: setupScopeRequiredPageWrapper(setupHomePage$),
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

    render();

    await set(setupClerk$, signal);
    signal.throwIfAborted();

    await set(setupRoutes$, signal);
    signal.throwIfAborted();
  },
);
