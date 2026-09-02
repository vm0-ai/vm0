import { brandedApiNamespace } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  type RouteEntry,
  withMigratedBrandedPaths,
} from "../signals/route-entry";

const CANONICAL_PREFIX = "/api/okou";
const LEGACY_PREFIX = "/api/zero";

// The legacy `/api/zero/**` paths this service still owes a caller, keyed by
// the canonical `/api/okou/**` path the same handler answers. #30667 deleted
// `LEGACY_ZERO_PATHS`, so none of them is derived any more: each was named
// directly by a `MIGRATED_BRANDED_PATHS` row. Restated here rather than
// imported from `route-entry.ts`, so narrowing that table fails this file
// instead of quietly agreeing with itself.
//
// The list is empty. #30668 took it from six paths to two once the Slack app
// console and `routes/slack-oauth.ts` began holding neutral URLs, #30812 took
// the Teams callback, and #31088 took the Slack install link — the last one,
// and the one no deploy could drain, because its branded form was handed to
// people rather than computed per request. Nothing on this service answers a
// branded path now.
//
// The cases driven from this list stay: they are what a slice re-adding a
// compatibility path has to satisfy, and restating the path here is how it
// does that.
const SERVED_LEGACY_PATHS: Readonly<Record<string, string>> = {};

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function canonicalPath(path: string): string {
  if (brandedApiNamespace(path) !== "zero") {
    return path;
  }
  return `${CANONICAL_PREFIX}${path.slice(LEGACY_PREFIX.length)}`;
}

// Both branded forms of every compatibility path, taken from the literal list
// above rather than from the production table.
function compatibilityPaths(): readonly string[] {
  return Object.entries(SERVED_LEGACY_PATHS).flat();
}

// Composed the way production registers routes, so a slice that moves a listed
// contract to its neutral path can satisfy this list by naming the two branded
// paths in the migrated-branded table. Keeping the path listed here is the
// point; which mechanism serves it is not.
function missingCompatibilityPaths(
  routes: readonly RouteEntry[],
): readonly string[] {
  const registeredPaths = new Set(
    withMigratedBrandedPaths(routes).map((entry) => {
      return entry.route.path;
    }),
  );
  return compatibilityPaths()
    .filter((path) => {
      return !registeredPaths.has(path);
    })
    .sort();
}

// Per-endpoint behaviour is covered through the endpoints themselves. This
// file asserts the properties no single endpoint can express: over the whole
// route table, which paths are registered and which legacy paths are still
// served on purpose.
describe("API namespace compatibility", () => {
  // Composed the way production registers routes: the declared paths plus the
  // branded rows. This is what a caller actually reaches, and it is the only
  // composition that finds a #28278-migrated contract at the branded paths its
  // released callers hold.
  const servedRoutes = withMigratedBrandedPaths(ROUTES);

  function registrationsFor(path: string): readonly RouteEntry[] {
    return servedRoutes.filter((entry) => {
      return entry.route.path === path;
    });
  }

  // A case pinning `/api/org` used to sit here. #28701 removed that path's
  // `LEGACY_ZERO_PATHS` row while a `MIGRATED_BRANDED_PATHS` row kept both
  // branded forms served, which is why removing twenty-five rows changed
  // nothing a caller could observe — the removed row recorded that the path was
  // owed rather than being what served it. #31088 removed the row that served
  // it too, so the path has no branded form left and the case has no subject.

  it("serves every listed legacy path with the handler that serves its canonical path", () => {
    for (const [canonical, legacy] of Object.entries(SERVED_LEGACY_PATHS)) {
      const sources = registrationsFor(canonical);
      expect(
        sources.length,
        `Expected at least one route serving ${canonical}`,
      ).toBeGreaterThan(0);

      for (const source of sources) {
        const key = `${source.route.method} ${legacy}`;
        const matches = servedRoutes.filter((entry) => {
          return routeKey(entry) === key;
        });
        expect(matches, `Missing registration for ${key}`).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(`Missing registration for ${key}`);
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path: legacy });
      }
    }
  });

  it("registers both branded forms of every listed compatibility path", () => {
    expect(missingCompatibilityPaths(ROUTES)).toStrictEqual([]);
  });

  // The regression #28278 hit ~354 times used to be pinned here: a contract
  // moves off `/api/okou/**` to a neutral path, both branded registrations
  // disappear, and every mechanism assertion in this file still passes, so the
  // literal list above is what has to fail. It needs a listed path to move, and
  // #31088 emptied the list, so the case has no subject. The synthetic twin in
  // `migrated-branded-paths.test.ts` keeps that guard on the mechanism itself,
  // where it does not depend on a shipped row.

  // A row whose canonical path nothing answers is a row no caller can use. Read
  // from the served composition rather than from `ROUTES`: once a #28278 slice
  // moves a contract to its neutral path, the canonical branded path is served
  // by the migrated-branded table instead of being declared by the contract.
  it("keeps every listed legacy path backed by a served canonical path", () => {
    const servedCanonicalPaths = new Set(
      servedRoutes.map(({ route }) => {
        return canonicalPath(route.path);
      }),
    );

    expect(
      Object.keys(SERVED_LEGACY_PATHS).filter((path) => {
        return !servedCanonicalPaths.has(path);
      }),
    ).toStrictEqual([]);
  });
});
