import { apiNamespaceAliasPaths } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withFinalProviderConsolePaths,
  withMigratedBrandedPaths,
} from "../signals/route-entry";

interface FinalConsoleRoute {
  readonly method: "GET" | "POST";
  readonly brandedPath: string;
  readonly finalPath: string;
}

// The six URLs the Slack and Microsoft consoles hold after #28278 Stage 0.
// Restated here so the registration is asserted against the issue table rather
// than against the map the production code reads.
//
// #28544 removed the two Feishu rows this list used to hold: no console points
// at either path, so both contracts moved to their neutral paths and both
// branded forms are served by `MIGRATED_BRANDED_PATHS` instead.
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
];

// The two rows #28544 moved to `MIGRATED_BRANDED_PATHS`, kept here as the
// subject of the deletion guard below rather than as an expectation.
const RETIRED_CONSOLE_ROUTES: readonly FinalConsoleRoute[] = [
  {
    method: "GET",
    brandedPath: "/api/okou/feishu/oauth/callback",
    finalPath: "/api/integrations/feishu/oauth/callback",
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

// A route declaring an arbitrary path, so the table can be probed with a path
// no contract declares any more. Built from a real entry so the produced
// registration is a real `RouteEntry` rather than a cast.
function probeRoute(method: "GET" | "POST", path: string): RouteEntry {
  const source = ROUTES.find((entry) => {
    return entry.route.method === method;
  });
  if (!source) {
    throw new Error(`Expected at least one ${method} route`);
  }
  return { route: { ...source.route, path }, handler: source.handler };
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
// six registrations are added and none of the other product routes gains a
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
        // A provider console, not a client we control, decides when these stop
        // being called, so none of the three forms may depend on the blanket
        // namespace fallback: every branded path here is listed in the #28356
        // compatibility table, and the final paths are outside the mechanism.
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
    }
  });

  it("leaves the final paths outside the branded namespace alias mechanism", () => {
    for (const { finalPath } of FINAL_CONSOLE_ROUTES) {
      expect(apiNamespaceAliasPaths(finalPath)).toStrictEqual([finalPath]);
    }
  });

  it("adds only these six paths and keeps every registration unique", () => {
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

  // A row is keyed by the branded path its contract declares, so when #28278
  // moves that contract to a neutral path the row stops matching instead of
  // colliding: every assertion above still passes, and the table keeps a Feishu
  // entry that describes a console commitment nobody holds. The registered set
  // cannot show that — the row produces nothing either way — so this feeds the
  // retired branded paths back in and reads the table directly. A leftover row
  // fails here rather than surviving as dead configuration.
  it("no longer holds a row for the two paths #28544 migrated", () => {
    const probes = RETIRED_CONSOLE_ROUTES.map(({ method, brandedPath }) => {
      return probeRoute(method, brandedPath);
    });

    expect(withFinalProviderConsolePaths(probes).map(routeKey)).toStrictEqual(
      RETIRED_CONSOLE_ROUTES.map(({ method, brandedPath }) => {
        return `${method} ${brandedPath}`;
      }),
    );
  });

  // The other side of the same edit: both routes must still answer on all three
  // forms, now through `MIGRATED_BRANDED_PATHS` instead of this table. Asserted
  // here so the deletion above cannot be read as retiring the paths — the two
  // Feishu installations in production hold the branded events URL in their own
  // consoles, which we cannot edit.
  it("keeps the migrated Feishu paths served on all three forms", () => {
    const servedRoutes = withMigratedBrandedPaths(registeredRoutes);

    for (const { method, brandedPath, finalPath } of RETIRED_CONSOLE_ROUTES) {
      const source = requireRegistration(
        servedRoutes,
        `${method} ${finalPath}`,
      );

      for (const path of [
        brandedPath,
        brandedPath.replace("/api/okou/", "/api/zero/"),
      ]) {
        const match = requireRegistration(servedRoutes, `${method} ${path}`);
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path });
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
    }
  });
});
