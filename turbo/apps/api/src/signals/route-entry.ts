import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  apiNamespaceAliasPaths,
  brandedApiNamespace,
} from "@okouai/api-contracts/contracts/api-namespaces";
import type { SignalRouteHandler } from "./context/route";

export type { SignalRouteHandler };

export interface RouteEntry {
  readonly route: AppRoute;
  readonly handler: SignalRouteHandler<unknown>;
}

function routeRegistrationKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

export function assertUniqueRouteRegistrations(
  routes: readonly RouteEntry[],
): void {
  const keys = new Set<string>();
  for (const entry of routes) {
    const key = routeRegistrationKey(entry);
    if (keys.has(key)) {
      throw new Error(`Duplicate API route registration: ${key}`);
    }
    keys.add(key);
  }
}

function routeEntryWithPath(entry: RouteEntry, path: string): RouteEntry {
  if (path === entry.route.path) {
    return entry;
  }
  return {
    route: { ...entry.route, path },
    handler: entry.handler,
  };
}

/**
 * True when the expansion may register `aliasPath` for a contract declaring
 * `declaredPath`. The declared path and the canonical `/api/okou/**` form
 * register; a derived `/api/zero/**` form never does.
 */
function servesNamespaceAliasPath(
  declaredPath: string,
  aliasPath: string,
): boolean {
  return (
    aliasPath === declaredPath || brandedApiNamespace(aliasPath) !== "zero"
  );
}

/**
 * Registers the canonical `/api/okou/**` form of every branded contract path.
 * The legacy `/api/zero/**` form is never derived.
 *
 * Until #28701 this expansion derived the legacy form unconditionally and
 * marked the registrations `LEGACY_ZERO_PATHS` did not list, so
 * `createAppWithRoutes` could report the first request that reached one. That
 * fallback existed because the request log retained about three days, which
 * cannot tell a drained caller apart from a weekly one. #28701 measured the
 * whole 6.3-day window instead, narrowed that table to the six paths a Slack or
 * Teams app configuration still held, and dropped both the derivation and the
 * reporting behind it.
 *
 * #30667 then removed the table itself. Each of its six paths was named
 * directly by a row of the branded compatibility table that used to sit below
 * this function, so none of them lost a registration, and nothing in this
 * repository produces a `/api/zero/**` URL any more — the last producer was
 * `callbackRedirectUri` in `routes/teams-oauth.ts`, unified onto the canonical
 * path in the same commit.
 *
 * #31088 then emptied that compatibility table and #31090 deleted it along
 * with the wrapper that applied it, so this expansion is the only thing left
 * that can produce a branded registration. Every contract declares a neutral
 * path, `apiNamespaceAliasPaths` returns a neutral path unchanged, and the
 * legacy form is never derived, so neither branded namespace is registered for
 * anything.
 */
export function withApiNamespaceAliases(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    return apiNamespaceAliasPaths(entry.route.path)
      .filter((path) => {
        return servesNamespaceAliasPath(entry.route.path, path);
      })
      .map((path) => {
        return routeEntryWithPath(entry, path);
      });
  });
}
