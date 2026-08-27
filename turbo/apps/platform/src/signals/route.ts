import { command, computed, state, type Command } from "ccstate";
import { match } from "path-to-regexp";
import type { RoutePath } from "./route-paths";
import { clerk$, needsOrgSelection$, resolveAppAuthUrl } from "./auth.ts";
import { pathname, pushState, replaceState, search } from "./location.ts";
import { setPageSignal$ } from "./page-signal.ts";
import { clearPage$ } from "./react-router.ts";
import { rootSignal$ } from "./root-signal.ts";
import {
  bestEffort,
  detach,
  onDomEventFn,
  onRejection,
  Reason,
  resetSignal,
  settle,
} from "./utils.ts";
import { logger } from "./log.ts";
import {
  capturePageView,
  markBootstrapRouteSetup$,
  markNavigationPushState$,
} from "../lib/posthog.ts";
import { recordAdAttribution$ } from "./bootstrap/ad-attribution.ts";
import { recordSignupAttribution$ } from "./bootstrap/signup-attribution.ts";
import { bootstrapGoogleAdsConversionMilestones$ } from "./bootstrap/google-ads-conversion-milestones.ts";

const L = logger("Route");

const reloadPathname$ = state(0);
const internalHistoryState$ = state<unknown>(window.history.state);

export const pathname$ = computed((get) => {
  get(reloadPathname$);
  return pathname();
});

export const searchParams$ = computed((get) => {
  get(reloadPathname$);
  return new URLSearchParams(search());
});

export const historyState$ = computed((get) => {
  return get(internalHistoryState$);
});

export const updateSearchParams$ = command(
  ({ set }, searchParams: URLSearchParams, historyState: unknown = {}) => {
    const str = searchParams.toString();
    pushState(historyState, "", `${pathname()}${str ? `?${str}` : ""}`);
    set(internalHistoryState$, historyState);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

export const replaceSearchParams$ = command(
  ({ set }, searchParams: URLSearchParams, historyState: unknown = {}) => {
    const str = searchParams.toString();
    replaceState(historyState, "", `${pathname()}${str ? `?${str}` : ""}`);
    set(internalHistoryState$, historyState);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

export const replacePathSilently$ = command(
  (
    { set },
    pathnameTemplate: Parameters<typeof generateRouterPath>[0],
    pathParams?: Parameters<typeof generateRouterPath>[1],
    searchParams?: URLSearchParams,
  ) => {
    const newPath = generateRouterPath(pathnameTemplate, pathParams);
    const searchStr = searchParams?.toString();
    replaceState({}, "", `${newPath}${searchStr ? `?${searchStr}` : ""}`);
    set(internalHistoryState$, {});
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

export type RouteSetup = Command<Promise<void> | void, [AbortSignal]>;

export type RouteSetupLoader = () => Promise<RouteSetup>;

type RoutePrefetch = Command<Promise<boolean>, [AbortSignal]>;

export interface LazyRouteSetup {
  readonly setup: RouteSetup;
  readonly prefetch: RoutePrefetch;
}

export function lazyRouteSetup(load: RouteSetupLoader): LazyRouteSetup {
  let loadedRoute:
    | {
        readonly rootSignal: AbortSignal;
        readonly setup: Promise<RouteSetup>;
      }
    | undefined;
  let activatedRootSignal: AbortSignal | undefined;
  let pendingSetup:
    | {
        readonly rootSignal: AbortSignal;
        readonly setupSignal: AbortSignal;
      }
    | undefined;

  const resolveRouteSetup$ = command(async ({ get }, signal: AbortSignal) => {
    const rootSignal = get(rootSignal$);
    if (loadedRoute?.rootSignal !== rootSignal) {
      loadedRoute = { rootSignal, setup: load() };
    }

    const pendingRoute = loadedRoute;
    const setup = await onRejection(pendingRoute.setup, () => {
      if (loadedRoute === pendingRoute) {
        loadedRoute = undefined;
      }
    });
    signal.throwIfAborted();
    rootSignal.throwIfAborted();
    if (get(rootSignal$) !== rootSignal) {
      throw new DOMException("Route setup root changed", "AbortError");
    }

    return setup;
  });

  const prefetch$ = command(async ({ get, set }, signal: AbortSignal) => {
    await set(resolveRouteSetup$, signal);
    const rootSignal = get(rootSignal$);
    if (pendingSetup?.rootSignal === rootSignal) {
      return pendingSetup.setupSignal.aborted;
    }
    return activatedRootSignal !== rootSignal;
  });

  const setup$ = command(async ({ get, set }, signal: AbortSignal) => {
    const resolvedSetup = await set(resolveRouteSetup$, signal);
    signal.throwIfAborted();
    const rootSignal = get(rootSignal$);
    rootSignal.throwIfAborted();
    const setupAttempt = { rootSignal, setupSignal: signal };
    pendingSetup = setupAttempt;
    const clearFailedAttempt = () => {
      signal.removeEventListener("abort", clearFailedAttempt);
      if (pendingSetup === setupAttempt) {
        pendingSetup = undefined;
        if (activatedRootSignal === rootSignal) {
          activatedRootSignal = undefined;
        }
      }
    };
    signal.addEventListener("abort", clearFailedAttempt, { once: true });
    const completeSetup = async () => {
      await set(resolvedSetup, signal);
      signal.throwIfAborted();
    };
    await onRejection(completeSetup(), clearFailedAttempt);
    signal.throwIfAborted();
    if (rootSignal.aborted || get(rootSignal$) !== rootSignal) {
      clearFailedAttempt();
      rootSignal.throwIfAborted();
      throw new DOMException("Route setup root changed", "AbortError");
    }
    if (pendingSetup !== setupAttempt) {
      throw new DOMException("Route setup was superseded", "AbortError");
    }
    signal.removeEventListener("abort", clearFailedAttempt);
    pendingSetup = undefined;
    activatedRootSignal = rootSignal;
  });

  return { prefetch: prefetch$, setup: setup$ };
}

interface Route {
  path: string;
  setup: RouteSetup;
  prefetch?: RoutePrefetch;
  analytics?: boolean;
}

function findMatchingRoute(
  config: readonly Route[],
  targetPathname: string,
): Route | null {
  for (const route of config) {
    const matcher = match(route.path, { decode: decodeURIComponent });
    if (matcher(targetPathname)) {
      return route;
    }
  }
  return null;
}

const internalRouteConfig$ = state<Route[] | undefined>(undefined);

export const prefetchRoute$ = command(
  ({ get, set }, targetPathname: string) => {
    const config = get(internalRouteConfig$);
    if (!config) {
      return Promise.resolve(false);
    }
    const route = findMatchingRoute(config, targetPathname);
    if (!route?.prefetch) {
      return Promise.resolve(false);
    }
    return set(route.prefetch, get(rootSignal$));
  },
);

const currentRoute$ = computed((get) => {
  const config = get(internalRouteConfig$);
  if (!config) {
    return null;
  }

  return findMatchingRoute(config, get(pathname$));
});

const clearPageForRouteBoundary$ = command(
  ({ get, set }, nextPathname: string) => {
    const config = get(internalRouteConfig$);
    const nextRoute = config ? findMatchingRoute(config, nextPathname) : null;
    if (get(currentRoute$) !== nextRoute) {
      set(clearPage$);
    }
  },
);

export const pathParams$ = computed((get) => {
  const currentRoute = get(currentRoute$);
  if (!currentRoute) {
    return undefined;
  }
  const matcher = match(currentRoute.path, { decode: decodeURIComponent });
  const currentPath = get(pathname$);
  const result = matcher(currentPath);
  return result ? result.params : undefined;
});

const resetRouteSignal$ = resetSignal();
const resetRoutePreparationSignal$ = resetSignal();

const prepareNavigationRoute$ = command(
  async (
    { get, set },
    targetPathname: string,
    signal: AbortSignal,
  ): Promise<Route | null> => {
    const config = get(internalRouteConfig$);
    const route = config ? findMatchingRoute(config, targetPathname) : null;
    if (route?.prefetch) {
      await set(route.prefetch, signal);
    }
    signal.throwIfAborted();
    return route;
  },
);

const loadRoute$ = command(
  async (
    { get, set },
    preparedRoute: Route | null | undefined,
    signal: AbortSignal,
  ) => {
    const currentRoute = get(currentRoute$);
    if (!currentRoute) {
      throw new Error("No route matches, pathname: " + get(pathname$));
    }
    if (preparedRoute !== undefined && preparedRoute !== currentRoute) {
      throw new DOMException("Prepared route changed", "AbortError");
    }
    set(markBootstrapRouteSetup$, currentRoute.path);
    L.debug("loading route", currentRoute.path);
    if (currentRoute.analytics !== false) {
      set(recordAdAttribution$, get(searchParams$));
    }

    let clearBeforeSetup = false;
    if (currentRoute.prefetch && preparedRoute !== currentRoute) {
      const preparationSignal = set(resetRoutePreparationSignal$, signal);
      clearBeforeSetup = await set(currentRoute.prefetch, preparationSignal);
      preparationSignal.throwIfAborted();
    }

    // Keep the active route fully owned while a cold boundary is loading. Once
    // preparation succeeds, remove its page before aborting the route signal so
    // a mounted page never observes a torn-down lifecycle.
    if (clearBeforeSetup) {
      set(clearPage$);
    }
    signal.throwIfAborted();
    const routeSignal = set(resetRouteSignal$, signal);
    await set(currentRoute.setup, routeSignal);
    signal.throwIfAborted();
    if (currentRoute.analytics !== false) {
      capturePageView();
    }
    // Record first-touch signup attribution as part of the route-load lifecycle.
    // Bind to the parent `signal`, not the per-route `routeSignal`: a superseding
    // route load aborts the previous `routeSignal` via resetRouteSignal$, and
    // binding here would reject the superseded load with AbortError. The parent
    // signal mirrors the `signal.throwIfAborted()` gate above, so supersession
    // completes cleanly. The command early-returns when there is nothing to
    // record, so this only performs network work on the first qualifying load.
    // Attribution is best-effort so a final failure after auth recovery cannot
    // reject the route load; the command only persists its dedupe marker after a
    // successful record, allowing a later route to retry.
    if (currentRoute.analytics !== false) {
      await bestEffort(set(recordSignupAttribution$, signal), signal);
      await settle(
        set(bootstrapGoogleAdsConversionMilestones$, signal),
        signal,
      );
    }
  },
);

const navigateToDefaultWhenInvalid$ = command(({ get, set }) => {
  const config = get(internalRouteConfig$);

  if (!config) {
    return;
  }

  if (!get(currentRoute$)) {
    set(reloadPathname$, (x) => {
      return x + 1;
    });
    pushState({}, "", "/");
    set(internalHistoryState$, {});
  }
});

export const initRoutes$ = command(
  async ({ set }, config: readonly Route[], signal: AbortSignal) => {
    set(internalRouteConfig$, config as Route[]);
    set(navigateToDefaultWhenInvalid$);

    window.addEventListener(
      "popstate",
      onDomEventFn(async (event: PopStateEvent) => {
        set(resetRoutePreparationSignal$, signal);
        set(internalHistoryState$, event.state);
        set(clearPageForRouteBoundary$, pathname());
        // History already moved before popstate fires. Abort the old route only
        // after its page is detached so it cannot render stale content while a
        // lazy target is preparing.
        set(resetRouteSignal$, signal);
        set(reloadPathname$, (x) => {
          return x + 1;
        });
        set(navigateToDefaultWhenInvalid$);
        await set(loadRoute$, undefined, signal);
      }),
      { signal },
    );

    await set(loadRoute$, undefined, signal);
  },
);

interface NavigateOptions {
  searchParams?: URLSearchParams;
  hash?: string;
  replace?: boolean;
}

function routeHash(hash: string | undefined): string {
  if (!hash) {
    return "";
  }
  return hash.startsWith("#") ? hash : `#${hash}`;
}

const navigate$ = command(
  async (
    { get, set },
    pathname: string,
    options: NavigateOptions,
    signal: AbortSignal,
  ) => {
    const searchStr = options.searchParams?.toString();
    const newPath = `${pathname}${searchStr ? `?${searchStr}` : ""}${routeHash(options.hash)}`;
    L.debug("navigating to", newPath);
    const rootSignal = get(rootSignal$);
    const preparationSignal = set(
      resetRoutePreparationSignal$,
      rootSignal,
      signal,
    );
    const preparedRoute = await set(
      prepareNavigationRoute$,
      pathname,
      preparationSignal,
    );
    signal.throwIfAborted();
    preparationSignal.throwIfAborted();
    rootSignal.throwIfAborted();
    if (get(rootSignal$) !== rootSignal) {
      throw new DOMException("Route preparation root changed", "AbortError");
    }

    // A programmatic navigation can prepare a cold boundary without detaching
    // the committed page. Once preparation succeeds, clear a cross-boundary
    // page before history and route-derived state move to the new location.
    set(clearPageForRouteBoundary$, pathname);
    if (options.replace) {
      replaceState({}, "", newPath);
    } else {
      pushState({}, "", newPath);
      set(markNavigationPushState$);
    }
    set(internalHistoryState$, {});
    set(reloadPathname$, (x) => {
      return x + 1;
    });
    await set(loadRoute$, preparedRoute, rootSignal);
    signal.throwIfAborted();
  },
);

export const detachedNavigateTo$ = command(
  (
    { set, get },
    pathname: Parameters<typeof generateRouterPath>[0],
    options?: {
      pathParams?: Parameters<typeof generateRouterPath>[1];
      searchParams?: URLSearchParams;
      hash?: string;
      replace?: boolean;
    },
  ) => {
    // eslint-disable-next-line ccstate/no-detach-in-signals -- confirmed by ethan@vm0.ai
    detach(
      set(
        navigate$,
        generateRouterPath(pathname, options?.pathParams),
        options ?? {},
        get(rootSignal$),
      ),
      Reason.Entrance,
    );
  },
);

type ExtractParamSegment<T extends string> = T extends `:${infer Param}`
  ? Record<Param, string>
  : Record<never, never>;

type ExtractParamSegments<T extends string> =
  T extends `${infer Segment}/${infer Rest}`
    ? ExtractParamSegment<Segment> & ExtractParamSegments<Rest>
    : ExtractParamSegment<T>;

type ExtractParams<T extends string> = T extends string
  ? keyof ExtractParamSegments<T> extends never
    ? undefined
    : ExtractParamSegments<T>
  : never;

export type RouterPathParams<T extends RoutePath = RoutePath> =
  ExtractParams<T>;

export const generateRouterPath = <T extends RoutePath>(
  path: T,
  pathParams?: ExtractParams<T>,
): string => {
  if (!pathParams || Object.keys(pathParams).length === 0) {
    return path;
  }
  let _path = path as string;
  for (const [key, value] of Object.entries(pathParams)) {
    _path = _path.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  return _path;
};

export const setupPageWrapper = (
  fn: Command<Promise<void> | void, [AbortSignal]>,
) => {
  return command(async ({ set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    await set(fn, signal);
  });
};

/**
 * Wraps a page setup function with authentication requirement.
 * Opens sign-in dialog if user is not authenticated.
 * Also redirects to the web app's choose-organization page when the user
 * needs to select an organization.
 */
export const setupAuthPageWrapper = (
  fn: Command<Promise<void> | void, [AbortSignal]>,
) => {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();

    if (!clerk.loaded) {
      return;
    }

    if (!clerk.user) {
      const signInUrl = new URL(
        clerk.buildSignInUrl({ redirectUrl: location.href }),
      );
      L.info("redirect unauthenticated user to app sign-in", {
        currentUrl: location.href,
        signInUrl: signInUrl.toString(),
        domain: signInUrl.searchParams.get("domain"),
        redirectUrl: signInUrl.searchParams.get("redirect_url"),
      });
      window.location.href = signInUrl.toString();
      return;
    }

    const needsSelection = await get(needsOrgSelection$);
    signal.throwIfAborted();

    if (needsSelection) {
      L.debug(
        "redirect to choose-organization because org selection is needed",
      );
      window.location.href = resolveAppAuthUrl(
        "/sign-in/tasks/choose-organization",
      );
      return;
    }

    await set(setupPageWrapper(fn), signal);
  });
};
