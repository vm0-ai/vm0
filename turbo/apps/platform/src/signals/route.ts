import { command, computed, state, type Command } from "ccstate";
import { match } from "path-to-regexp";
import type { RoutePath } from "../types/route.ts";
import { clerk$, needsOrgSelection$, resolveWebOrigin } from "./auth.ts";
import { pathname, pushState, replaceState, search } from "./location.ts";
import { setPageSignal$ } from "./page-signal.ts";
import { rootSignal$ } from "./root-signal.ts";
import { detach, onDomEventFn, Reason, resetSignal } from "./utils.ts";
import { logger } from "./log.ts";
import { capturePageView, markNavigationPushState$ } from "../lib/posthog.ts";
import { recordAdAttribution } from "./bootstrap/ad-attribution.ts";
import { recordSignupAttribution$ } from "./bootstrap/signup-attribution.ts";

const L = logger("Route");

const reloadPathname$ = state(0);

export const pathname$ = computed((get) => {
  get(reloadPathname$);
  return pathname();
});

export const searchParams$ = computed((get) => {
  get(reloadPathname$);
  return new URLSearchParams(search());
});

export const updateSearchParams$ = command(
  ({ set }, searchParams: URLSearchParams) => {
    const str = searchParams.toString();
    pushState({}, "", `${pathname()}${str ? `?${str}` : ""}`);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

export const replaceSearchParams$ = command(
  ({ set }, searchParams: URLSearchParams) => {
    const str = searchParams.toString();
    replaceState({}, "", `${pathname()}${str ? `?${str}` : ""}`);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

/**
 * Update the address bar to point at a different path without firing
 * route setup. Existing search params are preserved.
 *
 * Use this for in-page swaps where the page itself has already loaded
 * the new content into state — the URL just needs to catch up so
 * sharing/bookmarking and browser back work. Going through `navigate$`
 * instead would re-run the route setup command, which would re-bootstrap
 * page-level signals from scratch.
 */
export const pushPathSilently$ = command(
  (
    { set },
    pathnameTemplate: Parameters<typeof generateRouterPath>[0],
    pathParams?: Parameters<typeof generateRouterPath>[1],
  ) => {
    const newPath = generateRouterPath(pathnameTemplate, pathParams);
    pushState({}, "", `${newPath}${search()}`);
    set(reloadPathname$, (x) => {
      return x + 1;
    });
  },
);

interface Route {
  path: string;
  setup: Command<Promise<void> | void, [AbortSignal]>;
}

const internalRouteConfig$ = state<Route[] | undefined>(undefined);

const currentRoute$ = computed((get) => {
  const config = get(internalRouteConfig$);
  if (!config) {
    return null;
  }

  const currentPath = get(pathname$);

  for (const route of config) {
    const matcher = match(route.path, { decode: decodeURIComponent });
    const result = matcher(currentPath);
    if (result) {
      return route;
    }
  }

  return null;
});

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

const loadRoute$ = command(async ({ get, set }, signal: AbortSignal) => {
  const routeSignal = set(
    resetRouteSignal$,
    ...([signal].filter(Boolean) as AbortSignal[]),
  );

  const currentRoute = get(currentRoute$);
  if (!currentRoute) {
    throw new Error("No route matches, pathname: " + get(pathname$));
  }
  L.debug("loading route", currentRoute.path);
  recordAdAttribution(get(searchParams$));

  await set(currentRoute.setup, routeSignal);
  signal.throwIfAborted();
  capturePageView();
  // Record first-touch signup attribution as part of the route-load lifecycle.
  // Bind to the parent `signal`, not the per-route `routeSignal`: a superseding
  // route load aborts the previous `routeSignal` via resetRouteSignal$, and
  // binding here would reject the superseded load with AbortError. The parent
  // signal mirrors the `signal.throwIfAborted()` gate above, so supersession
  // completes cleanly. The command early-returns when there is nothing to
  // record, so this only performs network work on the first qualifying load.
  await set(recordSignupAttribution$, signal);
});

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
  }
});

export const initRoutes$ = command(
  async ({ set }, config: readonly Route[], signal: AbortSignal) => {
    set(internalRouteConfig$, config as Route[]);
    set(navigateToDefaultWhenInvalid$);

    window.addEventListener(
      "popstate",
      onDomEventFn(async () => {
        set(reloadPathname$, (x) => {
          return x + 1;
        });
        set(navigateToDefaultWhenInvalid$);
        await set(loadRoute$, signal);
      }),
      { signal },
    );

    await set(loadRoute$, signal);
  },
);

interface NavigateOptions {
  searchParams?: URLSearchParams;
  replace?: boolean;
}

export const navigate$ = command(
  async (
    { get, set },
    pathname: string,
    options: NavigateOptions,
    signal: AbortSignal,
  ) => {
    const searchStr = options.searchParams?.toString();
    const newPath = `${pathname}${searchStr ? `?${searchStr}` : ""}`;
    L.debug("navigating to", newPath);
    if (options.replace) {
      replaceState({}, "", newPath);
    } else {
      pushState({}, "", newPath);
      set(markNavigationPushState$);
    }
    set(reloadPathname$, (x) => {
      return x + 1;
    });
    // Use rootSignal$ (not the caller's route signal) so the new route gets
    // a fresh, non-aborted signal.  resetRouteSignal$ inside loadRoute$ will
    // abort the previous route's controller, which would poison any signal
    // derived from it — passing the caller's signal here causes the new
    // route's signal to be born-aborted.
    await set(loadRoute$, get(rootSignal$));
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

type ExtractParams<T extends string> =
  T extends `${string}/:${infer Param}/${infer Rest}`
    ? Record<Param, string> & ExtractParams<`/${Rest}`>
    : T extends `${string}/:${infer Param}`
      ? Record<Param, string>
      : undefined;

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

const setupPageWrapper = (fn: Command<Promise<void> | void, [AbortSignal]>) => {
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

    if (!clerk.user) {
      await clerk.redirectToSignIn();
      signal.throwIfAborted();
      return;
    }

    const needsSelection = await get(needsOrgSelection$);
    signal.throwIfAborted();

    if (needsSelection) {
      L.debug(
        "redirect to choose-organization because org selection is needed",
      );
      window.location.href = `${resolveWebOrigin()}/sign-in/tasks/choose-organization`;
      return;
    }

    await set(setupPageWrapper(fn), signal);
  });
};
