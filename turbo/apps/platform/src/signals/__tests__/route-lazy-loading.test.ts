import { command } from "ccstate";
import { describe, expect, it, vi } from "vitest";

import {
  mockPushState,
  mockReplaceState,
  pathname,
  setPathname,
  setSearch,
} from "../location.ts";
import { appSkeletonVisible$, hideAppSkeleton$ } from "../app-skeleton.ts";
import { page$, updatePage$ } from "../react-router.ts";
import {
  detachedNavigateTo$,
  initRoutes$,
  lazyRouteSetup,
  type RouteSetup,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { setRootSignal$ } from "../root-signal.ts";
import { createDeferredPromise, isAbortError } from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function deferred<T>() {
  return createDeferredPromise<T>(context.signal);
}

function installNavigation(path: string): void {
  setPathname(path, context.signal);
  setSearch("", context.signal);
  const updateLocation = (
    _data: unknown,
    _unused: string,
    url?: string | URL | null,
  ) => {
    const next = new URL(url?.toString() ?? "/", "http://localhost");
    setPathname(next.pathname, context.signal);
    setSearch(next.search, context.signal);
  };
  mockPushState(vi.fn(updateLocation), context.signal);
  mockReplaceState(vi.fn(updateLocation), context.signal);
  context.store.set(setRootSignal$, context.signal);
}

describe("lazy route setup", () => {
  it("resolves the loader before running the selected route setup", async () => {
    installNavigation(ROUTES.agents);
    const events: string[] = [];
    const setup$ = command((_ctx, signal: AbortSignal) => {
      expect(signal.aborted).toBeFalsy();
      events.push("setup");
    });

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: lazyRouteSetup(() => {
            events.push("load");
            return Promise.resolve(setup$);
          }),
        },
      ],
      context.signal,
    );

    expect(events).toStrictEqual(["load", "setup"]);
  });

  it("propagates a rejected route import", async () => {
    installNavigation(ROUTES.agents);
    const importError = new Error("route import failed");

    await expect(
      context.store.set(
        initRoutes$,
        [
          {
            path: ROUTES.agents,
            analytics: false,
            setup: lazyRouteSetup(() => {
              return Promise.reject(importError);
            }),
          },
        ],
        context.signal,
      ),
    ).rejects.toBe(importError);
  });

  it("keeps the skeleton visible until the selected route is ready", async () => {
    installNavigation(ROUTES.agents);
    const loaderStarted = deferred<void>();
    const releaseLoader = deferred<void>();
    const setupStarted = deferred<void>();
    const releaseSetup = deferred<void>();
    const setupFinished = deferred<void>();
    const agentsSetup$ = command(async ({ set }, signal: AbortSignal) => {
      set(updatePage$, "agents");
      await set(hideAppSkeleton$, signal);
    });
    const workflowsSetup$ = command(async ({ set }, signal: AbortSignal) => {
      setupStarted.resolve(undefined);
      await releaseSetup.promise;
      signal.throwIfAborted();
      set(updatePage$, "workflows");
      await set(hideAppSkeleton$, signal);
      setupFinished.resolve(undefined);
    });

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: lazyRouteSetup(() => {
            return Promise.resolve(agentsSetup$);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          setup: lazyRouteSetup(async () => {
            loaderStarted.resolve(undefined);
            await releaseLoader.promise;
            return workflowsSetup$;
          }),
        },
      ],
      context.signal,
    );

    expect(context.store.get(page$)).toBe("agents");
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await loaderStarted.promise;
    expect(context.store.get(page$)).toBeUndefined();
    expect(context.store.get(appSkeletonVisible$)).toBeTruthy();

    releaseLoader.resolve(undefined);
    await setupStarted.promise;
    expect(context.store.get(page$)).toBeUndefined();
    expect(context.store.get(appSkeletonVisible$)).toBeTruthy();

    releaseSetup.resolve(undefined);
    await setupFinished.promise;
    expect(context.store.get(page$)).toBe("workflows");
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
  });

  it("does not run a loader that resolves after its navigation is aborted", async () => {
    installNavigation(ROUTES.agents);
    const loaderStarted = deferred<void>();
    const releaseLoader = deferred<RouteSetup>();
    const nextRouteSetup = deferred<void>();
    let staleSetupCalls = 0;
    const staleSetup$ = command(() => {
      staleSetupCalls += 1;
    });
    const nextSetup$ = command(() => {
      nextRouteSetup.resolve(undefined);
    });

    const initialNavigation = context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: lazyRouteSetup(async () => {
            loaderStarted.resolve(undefined);
            return await releaseLoader.promise;
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          setup: lazyRouteSetup(() => {
            return Promise.resolve(nextSetup$);
          }),
        },
      ],
      context.signal,
    );

    await loaderStarted.promise;
    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await nextRouteSetup.promise;
    releaseLoader.resolve(staleSetup$);

    await expect(initialNavigation).rejects.toSatisfy(isAbortError);
    expect(staleSetupCalls).toBe(0);
    expect(pathname()).toBe(ROUTES.workflows);
  });

  it("navigates repeatedly between independently loaded route groups", async () => {
    installNavigation(ROUTES.agents);
    const agentSignals: AbortSignal[] = [];
    const workflowSignals: AbortSignal[] = [];
    const secondAgentSetup = deferred<void>();
    const workflowSetup = deferred<void>();
    let agentLoaderCalls = 0;
    let workflowLoaderCalls = 0;

    const agentSetup$ = command((_ctx, signal: AbortSignal) => {
      agentSignals.push(signal);
      if (agentSignals.length === 2) {
        secondAgentSetup.resolve(undefined);
      }
    });
    const workflowSetup$ = command((_ctx, signal: AbortSignal) => {
      workflowSignals.push(signal);
      workflowSetup.resolve(undefined);
    });

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: lazyRouteSetup(() => {
            agentLoaderCalls += 1;
            return Promise.resolve(agentSetup$);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          setup: lazyRouteSetup(() => {
            workflowLoaderCalls += 1;
            return Promise.resolve(workflowSetup$);
          }),
        },
      ],
      context.signal,
    );

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await workflowSetup.promise;
    expect(agentSignals[0]?.aborted).toBeTruthy();

    context.store.set(detachedNavigateTo$, ROUTES.agents);
    await secondAgentSetup.promise;
    expect(workflowSignals[0]?.aborted).toBeTruthy();
    expect(agentLoaderCalls).toBe(2);
    expect(workflowLoaderCalls).toBe(1);
    expect(pathname()).toBe(ROUTES.agents);
  });
});
