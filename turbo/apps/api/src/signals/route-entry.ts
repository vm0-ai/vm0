import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  apiNamespaceAliasPaths,
  BRANDED_API_NAMESPACE_PATHS,
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
 * Stage 0 of #28278. Provider OAuth callbacks are also served at their final
 * unbranded paths so the provider console allowlists — Feishu Open Platform,
 * Slack app configuration, Microsoft identity platform app registration — are
 * updated once instead of once per namespace. `/api/slack`, `/api/teams` and
 * `/api/feishu` hold nothing else, so the final shape is reachable now.
 *
 * This list is exhaustive on purpose. Emitting an unbranded path for every
 * branded route is Stage 2 of #28278, is gated on #26701, and would expose the
 * whole product surface under a second path.
 */
const UNBRANDED_PROVIDER_OAUTH_CALLBACK_SUFFIXES = [
  "/slack/oauth/callback",
  "/teams/oauth/callback",
  "/feishu/oauth/callback",
] as const;

function unbrandedProviderOauthCallbackPath(path: string): string | undefined {
  for (const namespacePath of BRANDED_API_NAMESPACE_PATHS) {
    for (const suffix of UNBRANDED_PROVIDER_OAUTH_CALLBACK_SUFFIXES) {
      if (path === `${namespacePath}${suffix}`) {
        return `/api${suffix}`;
      }
    }
  }
  return undefined;
}

/**
 * Adds the unbranded path for each provider OAuth callback while keeping every
 * branded path. Apply before `withApiNamespaceAliases` so a callback gains one
 * unbranded entry rather than one per branded namespace.
 */
export function withUnbrandedProviderOauthCallbacks(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    const unbrandedPath = unbrandedProviderOauthCallbackPath(entry.route.path);
    if (unbrandedPath === undefined) {
      return [entry];
    }
    return [entry, routeEntryWithPath(entry, unbrandedPath)];
  });
}

/**
 * Phase A compatibility for #26487. Remove only in a separately authorized
 * cleanup after legacy Platform, CLI, runner, Desktop, and stored callback
 * callers have drained, production telemetry confirms no Zero dependency,
 * and rollback no longer targets a release that requires /api/zero/**.
 */
export function withApiNamespaceAliases(
  routes: readonly RouteEntry[],
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    return apiNamespaceAliasPaths(entry.route.path).map((path) => {
      return routeEntryWithPath(entry, path);
    });
  });
}
