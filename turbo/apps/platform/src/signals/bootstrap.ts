import { command } from "ccstate";
import { setupClerk$ } from "./auth.ts";
import { setRootSignal$ } from "./root-signal.ts";
import { initRoutes$, setupPageWrapper } from "./route.ts";
import { setupHomePage$ } from "./home/home-page.ts";

const ROUTE_CONFIG = [
  {
    path: "/",
    setup: setupPageWrapper(setupHomePage$),
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
