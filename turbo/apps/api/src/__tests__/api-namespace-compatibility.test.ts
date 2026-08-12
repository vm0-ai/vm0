import { apiNamespaceAliasPaths } from "@vm0/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  type RouteEntry,
  withApiNamespaceAliases,
} from "../signals/route-entry";

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function requireBrandedRoute(): RouteEntry {
  const entry = ROUTES.find(({ route }) => {
    return route.path.startsWith("/api/zero/");
  });
  if (!entry) {
    throw new Error("Expected at least one branded API route");
  }
  return entry;
}

describe("API namespace compatibility", () => {
  const registeredRoutes = withApiNamespaceAliases(ROUTES);

  it("registers symmetric Zero and Okou paths with the same handler and schema", () => {
    const registrationCounts = new Map<string, number>();
    for (const entry of registeredRoutes) {
      const key = routeKey(entry);
      registrationCounts.set(key, (registrationCounts.get(key) ?? 0) + 1);
    }

    for (const source of ROUTES) {
      const paths = apiNamespaceAliasPaths(source.route.path);
      for (const path of paths) {
        const matches = registeredRoutes.filter(({ route }) => {
          return route.method === source.route.method && route.path === path;
        });
        expect(matches).toHaveLength(1);
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

  it("remains symmetric when the source contract is canonical Okou", () => {
    const source = requireBrandedRoute();
    const okouSource: RouteEntry = {
      route: {
        ...source.route,
        path: source.route.path.replace("/api/zero/", "/api/okou/"),
      },
      handler: source.handler,
    };

    expect(
      withApiNamespaceAliases([okouSource]).map(({ route }) => {
        return route.path;
      }),
    ).toStrictEqual([source.route.path, okouSource.route.path]);
  });

  it("rejects duplicate method and path registrations", () => {
    const source = requireBrandedRoute();
    expect(() => {
      withApiNamespaceAliases([source, source]);
    }).toThrow(`Duplicate API route registration: ${routeKey(source)}`);
  });
});
