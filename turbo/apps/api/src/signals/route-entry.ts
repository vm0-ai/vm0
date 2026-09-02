import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
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
 * A blanket expansion used to sit in front of this table, deriving the
 * canonical `/api/okou/**` form of a branded contract path and never the
 * legacy one. #28984 moved the last contract off the brand namespace, which
 * made that expansion an identity transform on every declared path, and
 * #31094 removed it.
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
 * A row names finished registrations: the paths it lists are registered as
 * written and nothing derives anything further from them.
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
