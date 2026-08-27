import { command } from "ccstate";
import { createElement } from "react";
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
  historyState$,
  initRoutes$,
  lazyRouteSetup,
  prefetchRoute$,
  type RouteSetup,
  updateSearchParams$,
} from "../route.ts";
import { ROUTES } from "../route-paths.ts";
import { setRootSignal$ } from "../root-signal.ts";
import {
  clearAllDetached,
  createDeferredPromise,
  isAbortError,
  resetSignal,
} from "../utils.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();

function deferred<T>() {
  return createDeferredPromise<T>(context.signal);
}

function installNavigation(path: string, beforeLocationChange?: () => void) {
  setPathname(path, context.signal);
  setSearch("", context.signal);
  const updateLocation = (
    _data: unknown,
    _unused: string,
    url?: string | URL | null,
  ) => {
    beforeLocationChange?.();
    const next = new URL(url?.toString() ?? "/", "http://localhost");
    setPathname(next.pathname, context.signal);
    setSearch(next.search, context.signal);
  };
  const pushStateMock = vi.fn<typeof updateLocation>(updateLocation);
  const replaceStateMock = vi.fn<typeof updateLocation>(updateLocation);
  mockPushState(pushStateMock, context.signal);
  mockReplaceState(replaceStateMock, context.signal);
  context.store.set(setRootSignal$, context.signal);
  return { pushStateMock, replaceStateMock };
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
          ...lazyRouteSetup(() => {
            events.push("load");
            return Promise.resolve(setup$);
          }),
        },
      ],
      context.signal,
    );

    expect(events).toStrictEqual(["load", "setup"]);
  });

  it("propagates a rejected route import and retries it later", async () => {
    installNavigation(ROUTES.agents);
    const importError = new Error("route import failed");
    let loaderCalls = 0;
    let setupCalls = 0;
    const setup$ = command(() => {
      setupCalls += 1;
    });
    const route = lazyRouteSetup(() => {
      loaderCalls += 1;
      if (loaderCalls === 1) {
        return Promise.reject(importError);
      }
      return Promise.resolve(setup$);
    });

    await expect(
      context.store.set(
        initRoutes$,
        [
          {
            path: ROUTES.agents,
            analytics: false,
            ...route,
          },
        ],
        context.signal,
      ),
    ).rejects.toBe(importError);

    await expect(
      context.store.set(route.setup, context.signal),
    ).resolves.toBeUndefined();
    expect(loaderCalls).toBe(2);
    expect(setupCalls).toBe(1);
  });

  it("keeps a boundary cold when its first setup rejects", async () => {
    installNavigation(ROUTES.workflows);
    const setupError = new Error("first setup failed");
    const agentsSetup = deferred<void>();
    const retrySetupStarted = deferred<void>();
    const releaseRetrySetup = deferred<void>();
    const retrySetupFinished = deferred<void>();
    let loaderCalls = 0;
    let setupCalls = 0;
    let agentsSignal: AbortSignal | undefined;
    const workflowsSetup$ = command(async ({ set }, signal: AbortSignal) => {
      setupCalls += 1;
      if (setupCalls === 1) {
        throw setupError;
      }
      retrySetupStarted.resolve(undefined);
      await releaseRetrySetup.promise;
      signal.throwIfAborted();
      set(updatePage$, "workflows");
      retrySetupFinished.resolve(undefined);
    });

    await expect(
      context.store.set(
        initRoutes$,
        [
          {
            path: ROUTES.agents,
            analytics: false,
            setup: command(({ set }, signal: AbortSignal) => {
              agentsSignal = signal;
              set(updatePage$, "agents");
              agentsSetup.resolve(undefined);
            }),
          },
          {
            path: ROUTES.workflows,
            analytics: false,
            ...lazyRouteSetup(() => {
              loaderCalls += 1;
              return Promise.resolve(workflowsSetup$);
            }),
          },
        ],
        context.signal,
      ),
    ).rejects.toBe(setupError);

    context.store.set(detachedNavigateTo$, ROUTES.agents);
    await agentsSetup.promise;
    expect(context.store.get(page$)).toBe("agents");
    expect(agentsSignal?.aborted).toBeFalsy();

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await retrySetupStarted.promise;
    expect(context.store.get(page$)).toBeUndefined();
    expect(agentsSignal?.aborted).toBeTruthy();

    releaseRetrySetup.resolve(undefined);
    await retrySetupFinished.promise;
    expect(context.store.get(page$)).toBe("workflows");
    expect(loaderCalls).toBe(1);
    expect(setupCalls).toBe(2);
  });

  it("keeps the bootstrap skeleton until the first cold route is ready", async () => {
    installNavigation(ROUTES.agents);
    const loaderStarted = deferred<void>();
    const releaseLoader = deferred<void>();
    const agentsSetup$ = command(async ({ set }, signal: AbortSignal) => {
      set(updatePage$, "agents");
      await set(hideAppSkeleton$, signal);
    });

    const initialRoute = context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          ...lazyRouteSetup(async () => {
            loaderStarted.resolve(undefined);
            await releaseLoader.promise;
            return agentsSetup$;
          }),
        },
      ],
      context.signal,
    );

    await loaderStarted.promise;
    expect(context.store.get(page$)).toBeUndefined();
    expect(context.store.get(appSkeletonVisible$)).toBeTruthy();

    releaseLoader.resolve(undefined);
    await initialRoute;
    expect(context.store.get(page$)).toBe("agents");
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
  });

  it("preserves current content while a cold route group is prepared", async () => {
    const loaderStarted = deferred<void>();
    const releaseLoader = deferred<void>();
    const setupStarted = deferred<void>();
    const releaseSetup = deferred<void>();
    const setupFinished = deferred<void>();
    let agentsSignal: AbortSignal | undefined;
    const historyHandoff: {
      page?: unknown;
      routeSignalAborted?: boolean;
    } = {};
    const { pushStateMock } = installNavigation(ROUTES.agents, () => {
      historyHandoff.page = context.store.get(page$);
      historyHandoff.routeSignalAborted = agentsSignal?.aborted;
    });
    const agentsSetup$ = command(async ({ set }, signal: AbortSignal) => {
      agentsSignal = signal;
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
          ...lazyRouteSetup(() => {
            return Promise.resolve(agentsSetup$);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          ...lazyRouteSetup(async () => {
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
    expect(context.store.get(page$)).toBe("agents");
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
    expect(agentsSignal?.aborted).toBeFalsy();
    expect(pathname()).toBe(ROUTES.agents);
    expect(pushStateMock).not.toHaveBeenCalled();

    releaseLoader.resolve(undefined);
    await setupStarted.promise;
    expect(historyHandoff).toStrictEqual({
      page: undefined,
      routeSignalAborted: false,
    });
    expect(pushStateMock).toHaveBeenCalledOnce();
    expect(context.store.get(page$)).toBeUndefined();
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
    expect(agentsSignal?.aborted).toBeTruthy();
    expect(pathname()).toBe(ROUTES.workflows);

    releaseSetup.resolve(undefined);
    await setupFinished.promise;
    expect(context.store.get(page$)).toBe("workflows");
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
  });

  it("clears an eager route boundary before history moves", async () => {
    let agentsSignal: AbortSignal | undefined;
    const historyHandoff: {
      page?: unknown;
      routeSignalAborted?: boolean;
    } = {};
    const { pushStateMock } = installNavigation(ROUTES.agents, () => {
      historyHandoff.page = context.store.get(page$);
      historyHandoff.routeSignalAborted = agentsSignal?.aborted;
    });
    const workflowSetupStarted = deferred<void>();
    const releaseWorkflowSetup = deferred<void>();
    const workflowSetupFinished = deferred<void>();

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: command(async ({ set }, signal: AbortSignal) => {
            agentsSignal = signal;
            set(updatePage$, "agents");
            await set(hideAppSkeleton$, signal);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          setup: command(async ({ set }, signal: AbortSignal) => {
            workflowSetupStarted.resolve(undefined);
            await releaseWorkflowSetup.promise;
            signal.throwIfAborted();
            set(updatePage$, "workflows");
            workflowSetupFinished.resolve(undefined);
          }),
        },
      ],
      context.signal,
    );

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await workflowSetupStarted.promise;

    expect(historyHandoff).toStrictEqual({
      page: undefined,
      routeSignalAborted: false,
    });
    expect(pushStateMock).toHaveBeenCalledOnce();
    expect(pathname()).toBe(ROUTES.workflows);
    expect(context.store.get(page$)).toBeUndefined();
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
    expect(agentsSignal?.aborted).toBeTruthy();

    releaseWorkflowSetup.resolve(undefined);
    await workflowSetupFinished.promise;
    expect(context.store.get(page$)).toBe("workflows");
  });

  it("clears a popstate route boundary before lazy preparation", async () => {
    const { pushStateMock } = installNavigation(ROUTES.agents);
    const restoredHistoryState = { source: "artifact-search" };
    const loaderStarted = deferred<void>();
    const releaseLoader = deferred<void>();
    const workflowSetupStarted = deferred<void>();
    const releaseWorkflowSetup = deferred<void>();
    const workflowSetupFinished = deferred<void>();
    let agentsSignal: AbortSignal | undefined;

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: command(async ({ set }, signal: AbortSignal) => {
            agentsSignal = signal;
            set(updatePage$, "agents");
            await set(hideAppSkeleton$, signal);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          ...lazyRouteSetup(async () => {
            loaderStarted.resolve(undefined);
            await releaseLoader.promise;
            return command(async ({ set }, signal: AbortSignal) => {
              workflowSetupStarted.resolve(undefined);
              await releaseWorkflowSetup.promise;
              signal.throwIfAborted();
              set(updatePage$, "workflows");
              workflowSetupFinished.resolve(undefined);
            });
          }),
        },
      ],
      context.signal,
    );

    setPathname(ROUTES.workflows, context.signal);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: restoredHistoryState }),
    );
    await loaderStarted.promise;

    expect(pathname()).toBe(ROUTES.workflows);
    expect(context.store.get(historyState$)).toBe(restoredHistoryState);
    expect(context.store.get(page$)).toBeUndefined();
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
    expect(agentsSignal?.aborted).toBeTruthy();
    expect(pushStateMock).not.toHaveBeenCalled();

    releaseLoader.resolve(undefined);
    await workflowSetupStarted.promise;

    releaseWorkflowSetup.resolve(undefined);
    await workflowSetupFinished.promise;
    expect(context.store.get(page$)).toBe("workflows");
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
          ...lazyRouteSetup(async () => {
            loaderStarted.resolve(undefined);
            return await releaseLoader.promise;
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          ...lazyRouteSetup(() => {
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

  it("cancels stale cold preparation before it can mutate history state", async () => {
    const { pushStateMock } = installNavigation(ROUTES.agents);
    const currentHistoryState = { source: "agents" };
    context.store.set(
      updateSearchParams$,
      new URLSearchParams(),
      currentHistoryState,
    );
    pushStateMock.mockClear();
    const workflowPreparationStarted = deferred<void>();
    const releaseWorkflowPreparation = deferred<void>();
    const settingsPreparationStarted = deferred<void>();
    const releaseSettingsPreparation = deferred<void>();
    const settingsSetupFinished = deferred<void>();
    let agentsSignal: AbortSignal | undefined;
    let workflowSetupCalls = 0;

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: command(async ({ set }, signal: AbortSignal) => {
            agentsSignal = signal;
            set(updatePage$, "agents");
            await set(hideAppSkeleton$, signal);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          prefetch: command(async (_ctx, signal: AbortSignal) => {
            workflowPreparationStarted.resolve(undefined);
            await releaseWorkflowPreparation.promise;
            signal.throwIfAborted();
            return true;
          }),
          setup: command(() => {
            workflowSetupCalls += 1;
          }),
        },
        {
          path: ROUTES.settings,
          analytics: false,
          prefetch: command(async (_ctx, signal: AbortSignal) => {
            settingsPreparationStarted.resolve(undefined);
            await releaseSettingsPreparation.promise;
            signal.throwIfAborted();
            return true;
          }),
          setup: command(({ set }) => {
            set(updatePage$, "settings");
            settingsSetupFinished.resolve(undefined);
          }),
        },
      ],
      context.signal,
    );

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await workflowPreparationStarted.promise;
    expect(pathname()).toBe(ROUTES.agents);
    expect(context.store.get(page$)).toBe("agents");
    expect(agentsSignal?.aborted).toBeFalsy();
    expect(context.store.get(historyState$)).toBe(currentHistoryState);
    expect(pushStateMock).not.toHaveBeenCalled();

    context.store.set(detachedNavigateTo$, ROUTES.settings);
    await settingsPreparationStarted.promise;
    expect(pathname()).toBe(ROUTES.agents);
    expect(context.store.get(page$)).toBe("agents");
    expect(agentsSignal?.aborted).toBeFalsy();
    expect(context.store.get(historyState$)).toBe(currentHistoryState);

    releaseSettingsPreparation.resolve(undefined);
    await settingsSetupFinished.promise;
    expect(pathname()).toBe(ROUTES.settings);
    expect(context.store.get(page$)).toBe("settings");
    expect(agentsSignal?.aborted).toBeTruthy();
    expect(context.store.get(historyState$)).toStrictEqual({});
    expect(pushStateMock).toHaveBeenCalledOnce();
    expect(pushStateMock.mock.calls[0]?.[2]).toBe(ROUTES.settings);

    releaseWorkflowPreparation.resolve(undefined);
    await clearAllDetached();
    expect(workflowSetupCalls).toBe(0);
    expect(pathname()).toBe(ROUTES.settings);
    expect(context.store.get(page$)).toBe("settings");
    expect(context.store.get(historyState$)).toStrictEqual({});
    expect(pushStateMock).toHaveBeenCalledOnce();
  });

  it("reuses resolved route groups across repeated navigation", async () => {
    installNavigation(ROUTES.agents);
    const agentSignals: AbortSignal[] = [];
    const workflowSignals: AbortSignal[] = [];
    const agentSetupPages: unknown[] = [];
    const secondAgentSetup = deferred<void>();
    const workflowSetup = deferred<void>();
    let agentLoaderCalls = 0;
    let workflowLoaderCalls = 0;

    const agentSetup$ = command(({ get, set }, signal: AbortSignal) => {
      agentSetupPages.push(get(page$));
      set(updatePage$, "agents");
      agentSignals.push(signal);
      if (agentSignals.length === 2) {
        secondAgentSetup.resolve(undefined);
      }
    });
    const workflowSetup$ = command(({ set }, signal: AbortSignal) => {
      set(updatePage$, "workflows");
      workflowSignals.push(signal);
      workflowSetup.resolve(undefined);
    });

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          ...lazyRouteSetup(() => {
            agentLoaderCalls += 1;
            return Promise.resolve(agentSetup$);
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          ...lazyRouteSetup(() => {
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
    expect(agentLoaderCalls).toBe(1);
    expect(workflowLoaderCalls).toBe(1);
    expect(agentSetupPages).toStrictEqual([undefined, undefined]);
    expect(pathname()).toBe(ROUTES.agents);
  });

  it("identity-guards stale setup finalizers across same-route navigation", async () => {
    installNavigation("/agents/agent-a/chat");
    const aRendered = deferred<void>();
    const releaseA = deferred<void>();
    const bRendered = deferred<void>();
    const releaseB = deferred<void>();
    const interactivePage = createElement("section", { id: "chat" });
    const setupPages: unknown[] = [];
    let setupCalls = 0;

    const chatSetup$ = command(async ({ get, set }, signal: AbortSignal) => {
      setupCalls += 1;
      setupPages.push(get(page$));
      if (setupCalls === 1) {
        set(updatePage$, interactivePage);
        aRendered.resolve(undefined);
        await releaseA.promise;
        signal.throwIfAborted();
        return;
      }
      bRendered.resolve(undefined);
      await releaseB.promise;
      signal.throwIfAborted();
    });
    const route = lazyRouteSetup(() => {
      return Promise.resolve(chatSetup$);
    });
    const resetSetupSignal$ = resetSignal();
    const signalA = context.store.set(resetSetupSignal$, context.signal);
    const attemptA = context.store.set(route.setup, signalA);

    await aRendered.promise;
    expect(context.store.get(page$)).toBe(interactivePage);
    await expect(
      context.store.set(route.prefetch, context.signal),
    ).resolves.toBeFalsy();

    const signalB = context.store.set(resetSetupSignal$, context.signal);
    const attemptB = context.store.set(route.setup, signalB);
    await bRendered.promise;
    expect(setupPages).toStrictEqual([undefined, interactivePage]);
    expect(context.store.get(page$)).toBe(interactivePage);

    releaseA.resolve(undefined);
    await expect(attemptA).rejects.toSatisfy(isAbortError);
    await expect(
      context.store.set(route.prefetch, context.signal),
    ).resolves.toBeFalsy();

    releaseB.resolve(undefined);
    await expect(attemptB).resolves.toBeUndefined();
    await expect(
      context.store.set(route.prefetch, context.signal),
    ).resolves.toBeFalsy();
    expect(context.store.get(page$)).toBe(interactivePage);
    expect(setupCalls).toBe(2);
  });

  it("prefetches only the matched route and reuses its pending load", async () => {
    installNavigation(ROUTES.agents);
    const loaderStarted = deferred<void>();
    const releaseLoader = deferred<void>();
    const workflowSetup = deferred<void>();
    let loaderCalls = 0;
    let unmatchedLoaderCalls = 0;
    let authSetupCalls = 0;
    let setupCalls = 0;
    const workflowSetup$ = command(({ set }) => {
      setupCalls += 1;
      set(updatePage$, "workflows");
      workflowSetup.resolve(undefined);
    });
    const workflowRoute = lazyRouteSetup(async () => {
      loaderCalls += 1;
      loaderStarted.resolve(undefined);
      await releaseLoader.promise;
      return workflowSetup$;
    });
    const authenticatedWorkflowSetup$ = command(
      async ({ set }, signal: AbortSignal) => {
        authSetupCalls += 1;
        await set(workflowRoute.setup, signal);
      },
    );
    const unmatchedRoute = lazyRouteSetup(() => {
      unmatchedLoaderCalls += 1;
      return Promise.resolve(command(() => {}));
    });

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: command(({ set }) => {
            set(updatePage$, "agents");
          }),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          prefetch: workflowRoute.prefetch,
          setup: authenticatedWorkflowSetup$,
        },
        {
          path: ROUTES.settings,
          analytics: false,
          ...unmatchedRoute,
        },
      ],
      context.signal,
    );

    const prefetch = context.store.set(prefetchRoute$, ROUTES.workflows);
    await loaderStarted.promise;
    expect(loaderCalls).toBe(1);
    expect(unmatchedLoaderCalls).toBe(0);
    expect(authSetupCalls).toBe(0);
    expect(setupCalls).toBe(0);
    expect(context.store.get(page$)).toBe("agents");
    expect(pathname()).toBe(ROUTES.agents);

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    releaseLoader.resolve(undefined);
    await prefetch;
    await workflowSetup.promise;

    expect(loaderCalls).toBe(1);
    expect(unmatchedLoaderCalls).toBe(0);
    expect(authSetupCalls).toBe(1);
    expect(setupCalls).toBe(1);
    expect(context.store.get(page$)).toBe("workflows");
  });

  it("retries navigation after a rejected route prefetch", async () => {
    installNavigation(ROUTES.agents);
    const importError = new Error("prefetch failed");
    const workflowSetup = deferred<void>();
    let loaderCalls = 0;
    const workflowSetup$ = command(() => {
      workflowSetup.resolve(undefined);
    });
    const workflowRoute = lazyRouteSetup(() => {
      loaderCalls += 1;
      if (loaderCalls === 1) {
        return Promise.reject(importError);
      }
      return Promise.resolve(workflowSetup$);
    });

    await context.store.set(
      initRoutes$,
      [
        {
          path: ROUTES.agents,
          analytics: false,
          setup: command(() => {}),
        },
        {
          path: ROUTES.workflows,
          analytics: false,
          ...workflowRoute,
        },
      ],
      context.signal,
    );

    await expect(
      context.store.set(prefetchRoute$, ROUTES.workflows),
    ).rejects.toBe(importError);

    context.store.set(detachedNavigateTo$, ROUTES.workflows);
    await workflowSetup.promise;
    expect(loaderCalls).toBe(2);
  });

  it("reloads a resolved route group for a new root lifecycle", async () => {
    const resetRootSignal$ = resetSignal();
    const firstRoot = context.store.set(resetRootSignal$, context.signal);
    let loaderCalls = 0;
    const setupSignals: AbortSignal[] = [];
    const setup$ = command((_ctx, signal: AbortSignal) => {
      setupSignals.push(signal);
    });
    const route = lazyRouteSetup(() => {
      loaderCalls += 1;
      return Promise.resolve(setup$);
    });

    context.store.set(setRootSignal$, firstRoot);
    await context.store.set(route.setup, firstRoot);

    const secondRoot = context.store.set(resetRootSignal$, context.signal);
    context.store.set(setRootSignal$, secondRoot);
    await context.store.set(route.setup, secondRoot);

    expect(loaderCalls).toBe(2);
    expect(setupSignals).toStrictEqual([firstRoot, secondRoot]);
  });

  it("does not reuse a pending prefetch across root lifecycles", async () => {
    const firstRoot = AbortSignal.any([context.signal]);
    const loaderStarted = deferred<void>();
    const releaseFirstLoader = deferred<RouteSetup>();
    let loaderCalls = 0;
    const setupSignals: AbortSignal[] = [];
    const setup$ = command((_ctx, signal: AbortSignal) => {
      setupSignals.push(signal);
    });
    const route = lazyRouteSetup(async () => {
      loaderCalls += 1;
      if (loaderCalls === 1) {
        loaderStarted.resolve(undefined);
        return await releaseFirstLoader.promise;
      }
      return setup$;
    });

    context.store.set(setRootSignal$, firstRoot);
    const pendingPrefetch = context.store.set(route.prefetch, firstRoot);
    await loaderStarted.promise;

    const secondRoot = AbortSignal.any([context.signal]);
    context.store.set(setRootSignal$, secondRoot);
    releaseFirstLoader.resolve(setup$);

    await expect(pendingPrefetch).rejects.toSatisfy(isAbortError);
    expect(setupSignals).toStrictEqual([]);

    await context.store.set(route.setup, secondRoot);
    expect(loaderCalls).toBe(2);
    expect(setupSignals).toStrictEqual([secondRoot]);
  });
});
