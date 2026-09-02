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
 * directly by a `MIGRATED_BRANDED_PATHS` row below, so none of them lost a
 * registration, and nothing in this repository produces a `/api/zero/**` URL
 * any more — the last producer was `callbackRedirectUri` in
 * `routes/teams-oauth.ts`, unified onto the canonical path in the same commit.
 *
 * #31088 then emptied `MIGRATED_BRANDED_PATHS`, so this expansion is the only
 * thing that can produce a branded registration. Every contract declares a
 * neutral path, `apiNamespaceAliasPaths` returns a neutral path unchanged, and
 * the legacy form is never derived, so neither branded namespace is registered
 * for anything.
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

/**
 * The branded paths a migrated route still answers on, keyed by the neutral
 * canonical path its contract now declares.
 *
 * The table is empty. It was the only thing that registered a branded path,
 * and since #30667 the only thing that registered a `/api/zero/**` path at
 * all, so with no row left neither `/api/okou/**` nor `/api/zero/**` is served
 * for any path. #31090 removes this constant and `withMigratedBrandedPaths`
 * with it; the mechanism is kept here only so that #31088's behavioural change
 * and that structural one stay separately attributable.
 *
 * A row was compatibility debt under #26701's removal gate, retired only on
 * request-log evidence that its holder was gone or on an owner decision
 * recorded against the row. #28709 first applied that gate and took the table
 * from 314 rows to 184; #28711, #28974, #28917, #28916, #30668, #30804,
 * #30812, #30807 and #31068 then took it to six, and #31088 took those six.
 * The reading rules each of those removals left behind are on their issues,
 * and the rows themselves are in this file's history.
 *
 * Two of the last six are worth naming here, because the reasoning that had
 * held them was wrong rather than merely spent. #28715 kept the two
 * `desktop/updates` rows on the belief that a hard-stopped Zero Desktop
 * reaches the Okou DMG through the branded form. It does not: `Download Okou`
 * resolves through the neutral `/api/desktop/updates/stable/darwin/arm64/dmg`,
 * and across 2026-09-01 07:00Z to 2026-09-02 07:30Z all 1,445 update requests
 * from 144 addresses were on that neutral path while both branded forms took
 * none — including from the 107 to 108 Zero installs that have been polling
 * `desktop/migration-policy`, `feature-switches` and `auth/me` since the policy
 * went `hard` on 2026-08-31T02:26Z. Those rows were gated on nothing, and
 * #26364 governs the Zero install base rather than this surface.
 */
type MigratedBrandedPathTable = Readonly<Record<string, readonly string[]>>;

const MIGRATED_BRANDED_PATHS: Readonly<Record<string, readonly string[]>> = {};

/**
 * Registers the branded paths named in `MIGRATED_BRANDED_PATHS`, so a contract
 * that has moved to its neutral path keeps serving the branded paths released
 * callers still hold.
 *
 * Applied after `withApiNamespaceAliases` and never before it: these paths are
 * finished registrations, and passing a row's `/api/zero/**` form back through
 * the expansion would derive its canonical sibling a second time and register
 * that path twice.
 */
export function withMigratedBrandedPaths(
  routes: readonly RouteEntry[],
  brandedPaths: MigratedBrandedPathTable = MIGRATED_BRANDED_PATHS,
): readonly RouteEntry[] {
  return routes.flatMap((entry) => {
    const migrated = brandedPaths[entry.route.path];
    if (migrated === undefined) {
      return [entry];
    }
    return [
      entry,
      ...migrated.map((path) => {
        return routeEntryWithPath(entry, path);
      }),
    ];
  });
}
