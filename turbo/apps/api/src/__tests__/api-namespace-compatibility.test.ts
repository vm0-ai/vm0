import { apiNamespaceAliasPaths } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withUnbrandedProviderOauthCallbacks,
} from "../signals/route-entry";

const UNBRANDED_PROVIDER_OAUTH_CALLBACK_SUFFIXES = [
  "/slack/oauth/callback",
  "/teams/oauth/callback",
  "/feishu/oauth/callback",
] as const;

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function requireBrandedRoute(): RouteEntry {
  const entry = ROUTES.find(({ route }) => {
    return route.path.startsWith("/api/okou/");
  });
  if (!entry) {
    throw new Error("Expected at least one branded API route");
  }
  return entry;
}

function requireCallbackRoute(suffix: string): RouteEntry {
  const entry = ROUTES.find(({ route }) => {
    return route.method === "GET" && route.path.endsWith(suffix);
  });
  if (!entry) {
    throw new Error(`Expected a provider OAuth callback route for ${suffix}`);
  }
  return entry;
}

describe("API namespace compatibility", () => {
  const registeredRoutes = withApiNamespaceAliases(
    withUnbrandedProviderOauthCallbacks(ROUTES),
  );

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
    expect(() => {
      assertUniqueRouteRegistrations(registeredRoutes);
    }).not.toThrow();
  });

  it("serves each provider OAuth callback from both branded namespaces and its unbranded path", () => {
    for (const suffix of UNBRANDED_PROVIDER_OAUTH_CALLBACK_SUFFIXES) {
      const source = requireCallbackRoute(suffix);
      const paths = [
        `/api/okou${suffix}`,
        `/api/zero${suffix}`,
        `/api${suffix}`,
      ];

      for (const path of paths) {
        const matches = registeredRoutes.filter(({ route }) => {
          return route.method === "GET" && route.path === path;
        });
        expect(matches).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(`Missing provider OAuth callback route for ${path}`);
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path });
      }
    }
  });

  it("adds an unbranded path for the provider OAuth callbacks and nothing else", () => {
    const brandedOnlyKeys = new Set(
      withApiNamespaceAliases(ROUTES).map(routeKey),
    );
    const addedKeys = registeredRoutes
      .map(routeKey)
      .filter((key) => {
        return !brandedOnlyKeys.has(key);
      })
      .sort();

    expect(addedKeys).toStrictEqual(
      UNBRANDED_PROVIDER_OAUTH_CALLBACK_SUFFIXES.map((suffix) => {
        return `GET /api${suffix}`;
      }).sort(),
    );
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

  it("remains symmetric when the source contract uses the legacy Zero path", () => {
    const source = requireBrandedRoute();
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
    const source = requireBrandedRoute();
    const composedRouteSlice = withApiNamespaceAliases([source, source]);

    expect(composedRouteSlice).toHaveLength(4);
    expect(() => {
      assertUniqueRouteRegistrations(composedRouteSlice);
    }).toThrow(`Duplicate API route registration: ${routeKey(source)}`);
  });
});
