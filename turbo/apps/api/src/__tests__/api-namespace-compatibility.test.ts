import {
  apiNamespaceAliasPaths,
  brandedApiNamespace,
} from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
} from "../signals/route-entry";

const CANONICAL_PREFIX = "/api/okou";
const LEGACY_PREFIX = "/api/zero";

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function canonicalPath(path: string): string {
  if (brandedApiNamespace(path) !== "zero") {
    return path;
  }
  return `${CANONICAL_PREFIX}${path.slice(LEGACY_PREFIX.length)}`;
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
// route table, which paths are registered and that no branded path is among
// them.
//
// A second stage used to sit behind the expansion, registering the branded
// paths a #28278-migrated contract owed its released callers. #31088 emptied
// its table and #31090 removed it, so this composition is what a caller
// reaches, and the cases this file drove off the list of compatibility paths
// went with the mechanism that could serve one.
describe("API namespace compatibility", () => {
  const registeredRoutes = withApiNamespaceAliases(ROUTES);

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
  // ones `LEGACY_ZERO_PATHS` named; with that table gone it derives none. The
  // composed branded declaration is what carries this assertion — `ROUTES`
  // declares no branded path any more, so the sweep over it would pass whatever
  // the expansion did.
  it("derives no legacy path from a branded declaration", () => {
    const declared = brandedRouteSource();

    expect(
      withApiNamespaceAliases([declared]).map(({ route }) => {
        return route.path;
      }),
    ).toStrictEqual([declared.route.path]);
  });

  // The whole-table consequence, read off the composition rather than off
  // `ROUTES`: every contract declares a neutral path, the expansion returns one
  // unchanged, and nothing else registers a path any more, so the composition
  // is the declared table exactly and holds no branded path in either
  // namespace. This is what fails if a contract starts declaring a branded path
  // again, and it is why `/api/okou/**` and `/api/zero/**` are 404 in
  // production.
  it("registers no branded path for any route in the production table", () => {
    expect(
      registeredRoutes
        .map(({ route }) => {
          return route.path;
        })
        .filter((path) => {
          return brandedApiNamespace(path) !== undefined;
        })
        .sort(),
    ).toStrictEqual([]);
    expect(registeredRoutes).toHaveLength(ROUTES.length);
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
});
