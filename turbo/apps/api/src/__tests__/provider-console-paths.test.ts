import { apiNamespaceAliasPaths } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withFinalProviderConsolePaths,
} from "../signals/route-entry";

interface FinalConsoleRoute {
  readonly method: "GET" | "POST";
  readonly brandedPath: string;
  readonly finalPath: string;
}

// The eight URLs the Feishu, Slack, and Microsoft consoles hold after #28278
// Stage 0. Restated here so the registration is asserted against the issue
// table rather than against the map the production code reads.
const FINAL_CONSOLE_ROUTES: readonly FinalConsoleRoute[] = [
  {
    method: "GET",
    brandedPath: "/api/okou/slack/oauth/callback",
    finalPath: "/api/integrations/slack/oauth/callback",
  },
  {
    method: "GET",
    brandedPath: "/api/okou/teams/oauth/callback",
    finalPath: "/api/integrations/teams/oauth/callback",
  },
  {
    method: "GET",
    brandedPath: "/api/okou/feishu/oauth/callback",
    finalPath: "/api/integrations/feishu/oauth/callback",
  },
  {
    method: "POST",
    brandedPath: "/api/okou/slack/events",
    finalPath: "/api/webhooks/slack/events",
  },
  {
    method: "POST",
    brandedPath: "/api/okou/slack/commands",
    finalPath: "/api/webhooks/slack/commands",
  },
  {
    method: "POST",
    brandedPath: "/api/okou/slack/interactive",
    finalPath: "/api/webhooks/slack/interactive",
  },
  {
    method: "POST",
    brandedPath: "/api/okou/teams/bot",
    finalPath: "/api/webhooks/teams/bot",
  },
  {
    method: "POST",
    brandedPath: "/api/okou/feishu/events/:installationId",
    finalPath: "/api/webhooks/feishu/events/:installationId",
  },
];

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function requireSourceRoute(final: FinalConsoleRoute): RouteEntry {
  const source = ROUTES.find(({ route }) => {
    return route.method === final.method && route.path === final.brandedPath;
  });
  if (!source) {
    throw new Error(
      `Expected a route serving ${final.method} ${final.brandedPath}`,
    );
  }
  return source;
}

function requireRegistration(
  registeredRoutes: readonly RouteEntry[],
  key: string,
): RouteEntry {
  const matches = registeredRoutes.filter((entry) => {
    return routeKey(entry) === key;
  });
  expect(matches).toHaveLength(1);
  const match = matches[0];
  if (!match) {
    throw new Error(`Missing route registration for ${key}`);
  }
  return match;
}

// Per-endpoint behaviour is covered through the endpoints themselves in
// routes/__tests__/provider-console-paths.test.ts. This file asserts the one
// property no endpoint can express: over the whole route table, exactly these
// eight registrations are added and none of the other product routes gains a
// second path.
describe("final provider console paths", () => {
  const registeredRoutes = withApiNamespaceAliases(
    withFinalProviderConsolePaths(ROUTES),
  );

  it("serves every final path with the handler that already serves it", () => {
    for (const final of FINAL_CONSOLE_ROUTES) {
      const source = requireSourceRoute(final);
      const paths = [
        final.brandedPath,
        final.brandedPath.replace("/api/okou/", "/api/zero/"),
        final.finalPath,
      ];

      for (const path of paths) {
        const key = `${final.method} ${path}`;
        const match = requireRegistration(registeredRoutes, key);
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path });
      }
    }
  });

  it("leaves the final paths outside the branded namespace alias mechanism", () => {
    for (const { finalPath } of FINAL_CONSOLE_ROUTES) {
      expect(apiNamespaceAliasPaths(finalPath)).toStrictEqual([finalPath]);
    }
  });

  it("adds only these eight paths and keeps every registration unique", () => {
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
      FINAL_CONSOLE_ROUTES.map(({ method, finalPath }) => {
        return `${method} ${finalPath}`;
      }).sort(),
    );
    expect(() => {
      assertUniqueRouteRegistrations(registeredRoutes);
    }).not.toThrow();
  });
});
