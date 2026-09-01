import {
  apiNamespaceAliasPaths,
  brandedApiNamespace,
} from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withMigratedBrandedPaths,
} from "../signals/route-entry";

const CANONICAL_PREFIX = "/api/okou";
const LEGACY_PREFIX = "/api/zero";

// The six legacy `/api/zero/**` paths this service still owes a caller, keyed
// by the canonical `/api/okou/**` path the same handler answers. #30667 deleted
// `LEGACY_ZERO_PATHS`, so none of them is derived any more: each is named
// directly by a `MIGRATED_BRANDED_PATHS` row. Restated here rather than
// imported from `route-entry.ts`, so narrowing that table fails this file
// instead of quietly agreeing with itself.
//
// Every row is held by a Slack or Teams app configuration: a provider console
// holds the URL, so no deploy and no client release drains it. `slack/commands`
// and `slack/interactive` carried no traffic in the 6.3 days
// `vm0-request-log-prod` retained when #28701 read it, and stay because they
// live in the same Slack app configuration as the Event Subscriptions URL that
// demonstrably still points at the legacy path.
const SERVED_LEGACY_PATHS: Readonly<Record<string, string>> = {
  "/api/okou/slack/events": "/api/zero/slack/events",
  "/api/okou/slack/oauth/install": "/api/zero/slack/oauth/install",
  "/api/okou/slack/oauth/callback": "/api/zero/slack/oauth/callback",
  "/api/okou/slack/commands": "/api/zero/slack/commands",
  "/api/okou/slack/interactive": "/api/zero/slack/interactive",
  "/api/okou/teams/oauth/callback": "/api/zero/teams/oauth/callback",
};

// A row #28701 removed from `LEGACY_ZERO_PATHS` whose path did not retire with
// it: `MIGRATED_BRANDED_PATHS` names both branded forms of the neutral
// `/api/org` contract, so the removed row recorded that the path was owed
// rather than being what served it. Pinned here because it is why removing
// twenty-five rows changed nothing a caller can observe, and why #30667 could
// remove the remaining six the same way.
const MIGRATED_BRANDED_SUBJECT = {
  neutral: "/api/org",
  canonical: "/api/okou/org",
  legacy: "/api/zero/org",
} as const;

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
// above rather than from `apiNamespaceAliasPaths` or the production table.
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
    withMigratedBrandedPaths(withApiNamespaceAliases(routes)).map((entry) => {
      return entry.route.path;
    }),
  );
  return compatibilityPaths()
    .filter((path) => {
      return !registeredPaths.has(path);
    })
    .sort();
}

// A route entry declaring a branded path, for the three guards below that pin
// how the expansion treats one. #28946 moved the last contract off
// `/api/okou/**`, so `ROUTES` no longer holds such an entry and it has to be
// composed. The expansion still has to handle a branded declaration —
// `apiNamespaceAliasPaths` and `servesNamespaceAliasPath` both branch on one —
// and these are the only tests left that reach that branch.
//
// Composed from a real neutral route so everything but the path is ordinary.
// Which route no longer matters: since #30667 the expansion consults no table,
// so its own rule is the only thing deciding whether the legacy form registers.
function brandedRouteSource(): RouteEntry {
  const entry = ROUTES.find(({ route }) => {
    return (
      brandedApiNamespace(route.path) === undefined &&
      route.path.startsWith("/api/")
    );
  });
  if (!entry) {
    throw new Error("Expected a neutral /api/ route to compose a branded path");
  }
  return {
    route: { ...entry.route, path: brandedPath(entry.route.path) },
    handler: entry.handler,
  };
}

function brandedPath(neutralPath: string): string {
  return `${CANONICAL_PREFIX}${neutralPath.slice("/api".length)}`;
}

// Per-endpoint behaviour is covered through the endpoints themselves. This
// file asserts the properties no single endpoint can express: over the whole
// route table, which paths are registered, which legacy paths are still served
// on purpose, and that the expansion derives none of them.
describe("API namespace compatibility", () => {
  const registeredRoutes = withApiNamespaceAliases(ROUTES);
  // Composed the way production registers routes. The expansion above is the
  // mechanism this file pins; this is what a caller actually reaches, and it is
  // the only composition that still finds a #28278-migrated contract at the
  // branded paths its released callers hold.
  const servedRoutes = withMigratedBrandedPaths(registeredRoutes);

  function registrationsFor(path: string): readonly RouteEntry[] {
    return servedRoutes.filter((entry) => {
      return entry.route.path === path;
    });
  }

  it("registers the declared path and the canonical form of every contract", () => {
    const registrationCounts = new Map<string, number>();
    for (const entry of registeredRoutes) {
      const key = routeKey(entry);
      registrationCounts.set(key, (registrationCounts.get(key) ?? 0) + 1);
    }

    for (const source of ROUTES) {
      const paths = new Set([
        source.route.path,
        canonicalPath(source.route.path),
      ]);
      for (const path of paths) {
        const matches = registeredRoutes.filter(({ route }) => {
          return route.method === source.route.method && route.path === path;
        });
        expect(
          matches,
          `Missing registration for ${source.route.method} ${path}`,
        ).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(
            `Missing API namespace alias for ${routeKey(source)}`,
          );
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path });
      }
    }

    expect(
      [...registrationCounts.values()].filter((count) => {
        return count !== 1;
      }),
    ).toStrictEqual([]);
    expect(() => {
      assertUniqueRouteRegistrations(registeredRoutes);
    }).not.toThrow();
  });

  // What #28701 replaced the fallback with and #30667 finished. The expansion
  // used to derive the legacy form of every branded contract path and keep the
  // ones `LEGACY_ZERO_PATHS` named; with that table gone it derives none, and a
  // `/api/zero/**` path exists only where a `MIGRATED_BRANDED_PATHS` row names
  // it. The composed branded declaration is what carries this assertion —
  // `ROUTES` declares no branded path any more, so the sweep over it would pass
  // whatever the expansion did.
  it("derives no legacy path from a branded declaration", () => {
    const declared = brandedRouteSource();

    expect(
      withApiNamespaceAliases([declared]).map(({ route }) => {
        return route.path;
      }),
    ).toStrictEqual([declared.route.path]);
    expect(
      registeredRoutes
        .map(({ route }) => {
          return route.path;
        })
        .filter((path) => {
          return brandedApiNamespace(path) === "zero";
        })
        .sort(),
    ).toStrictEqual([]);
  });

  // The issue that narrowed the table proposed `/api/zero/org` as the retired
  // subject, from a request-log window where its traffic had stopped. It is not
  // retired, and this pins why: the row removed from the compatibility table is
  // not what served the path.
  it("keeps a removed row's path served by the migrated branded table", () => {
    for (const path of Object.values(MIGRATED_BRANDED_SUBJECT)) {
      expect(
        registrationsFor(path).length,
        `Expected ${path} to stay served`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps neutral health, webhook, and product-scoped Desktop routes single", () => {
    const neutralPaths = [
      "/health",
      "/api/webhooks/clerk",
      "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
    ] as const;

    for (const path of neutralPaths) {
      const matches = registeredRoutes.filter((entry) => {
        return entry.route.path === path;
      });
      expect(matches).toHaveLength(1);
      expect(apiNamespaceAliasPaths(path)).toStrictEqual([path]);
    }
  });

  it("registers the canonical form when the source contract uses the legacy Zero path", () => {
    const source = brandedRouteSource();
    const zeroSource: RouteEntry = {
      route: {
        ...source.route,
        path: source.route.path.replace("/api/okou/", "/api/zero/"),
      },
      handler: source.handler,
    };

    expect(
      withApiNamespaceAliases([zeroSource]).map(({ route }) => {
        return route.path;
      }),
    ).toStrictEqual([source.route.path, zeroSource.route.path]);
  });

  it("rejects duplicate method and path registrations", () => {
    const source = brandedRouteSource();
    const composedRouteSlice = withApiNamespaceAliases([source, source]);

    expect(composedRouteSlice).toHaveLength(2);
    expect(() => {
      assertUniqueRouteRegistrations(composedRouteSlice);
    }).toThrow(`Duplicate API route registration: ${routeKey(source)}`);
  });

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

  // The regression #28278 hit ~354 times: a contract moves off `/api/okou/**`
  // to a neutral path, both branded registrations disappear, and every
  // mechanism assertion in this file still passes. This pins that the literal
  // list is what fails, so such a migration cannot go green and then 404 in
  // production. Removing the path from the list is the way out, and it has to
  // be deliberate.
  //
  // #28600 moved the last branded contract, so the subject is now a route that
  // has already migrated, moved a second time to a path no
  // `MIGRATED_BRANDED_PATHS` row names. That is the same failure: a slice edits
  // the contract and forgets the rows the branded paths depend on.
  it("reports the branded registrations a neutral contract migration would drop", () => {
    const canonical = "/api/okou/slack/events";
    const legacy = "/api/zero/slack/events";
    const declared = "/api/webhooks/slack/events";
    const neutral = "/api/slack/events";
    expect(
      SERVED_LEGACY_PATHS[canonical],
      `${canonical} must stay in the served-legacy list for this guard to mean anything`,
    ).toBe(legacy);
    expect(
      ROUTES.filter((entry) => {
        return entry.route.path === declared;
      }),
      `Expected a contract declaring ${declared} for this guard to move something`,
    ).not.toHaveLength(0);

    const migratedRoutes = ROUTES.map((entry): RouteEntry => {
      if (entry.route.path !== declared) {
        return entry;
      }
      return {
        route: { ...entry.route, path: neutral },
        handler: entry.handler,
      };
    });
    const migratedRegistrations = withApiNamespaceAliases(migratedRoutes);

    // The mechanism stays internally consistent, which is exactly why it cannot
    // be the thing that catches this.
    expect(
      migratedRegistrations.map((entry) => {
        return entry.route.path;
      }),
    ).toContain(neutral);
    expect(apiNamespaceAliasPaths(neutral)).toStrictEqual([neutral]);
    expect(() => {
      assertUniqueRouteRegistrations(migratedRegistrations);
    }).not.toThrow();

    // The literal list is what notices.
    expect(missingCompatibilityPaths(migratedRoutes)).toStrictEqual(
      [canonical, legacy].sort(),
    );
  });

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
