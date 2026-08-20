import { apiNamespaceAliasPaths } from "@okouai/api-contracts/contracts/api-namespaces";

import { ROUTES } from "../signals/route";
import {
  type RouteEntry,
  withApiNamespaceAliases,
  withFinalProviderConsolePaths,
  withMigratedBrandedPaths,
} from "../signals/route-entry";

interface MigratedRoute {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly neutralPath: string;
  readonly okouPath: string;
  readonly zeroPath: string;
}

// The goal and hosted-site routes #28419 moved off the brand namespace, with
// all three forms written out. Nothing here is derived:
// `apiNamespaceAliasPaths` returns a neutral path unchanged, so deriving the
// branded forms from it would assert that the migration did nothing. A path
// parameter is reproduced verbatim, because `MIGRATED_BRANDED_PATHS` matches
// `entry.route.path` exactly.
const MIGRATED_ROUTES: readonly MigratedRoute[] = [
  {
    method: "POST",
    neutralPath: "/api/goal",
    okouPath: "/api/okou/goal",
    zeroPath: "/api/zero/goal",
  },
  {
    method: "PATCH",
    neutralPath: "/api/goal",
    okouPath: "/api/okou/goal",
    zeroPath: "/api/zero/goal",
  },
  {
    method: "GET",
    neutralPath: "/api/goal",
    okouPath: "/api/okou/goal",
    zeroPath: "/api/zero/goal",
  },
  {
    method: "DELETE",
    neutralPath: "/api/goal",
    okouPath: "/api/okou/goal",
    zeroPath: "/api/zero/goal",
  },
  {
    method: "POST",
    neutralPath: "/api/goal/block",
    okouPath: "/api/okou/goal/block",
    zeroPath: "/api/zero/goal/block",
  },
  {
    method: "POST",
    neutralPath: "/api/goal/complete",
    okouPath: "/api/okou/goal/complete",
    zeroPath: "/api/zero/goal/complete",
  },
  {
    method: "POST",
    neutralPath: "/api/goal/pause",
    okouPath: "/api/okou/goal/pause",
    zeroPath: "/api/zero/goal/pause",
  },
  {
    method: "POST",
    neutralPath: "/api/goal/resume",
    okouPath: "/api/okou/goal/resume",
    zeroPath: "/api/zero/goal/resume",
  },
  {
    method: "POST",
    neutralPath: "/api/host/deployments/:deploymentId/complete",
    okouPath: "/api/okou/host/deployments/:deploymentId/complete",
    zeroPath: "/api/zero/host/deployments/:deploymentId/complete",
  },
  {
    method: "POST",
    neutralPath: "/api/host/deployments/prepare",
    okouPath: "/api/okou/host/deployments/prepare",
    zeroPath: "/api/zero/host/deployments/prepare",
  },
  {
    method: "GET",
    neutralPath: "/api/host/sites/:publicSlug/files",
    okouPath: "/api/okou/host/sites/:publicSlug/files",
    zeroPath: "/api/zero/host/sites/:publicSlug/files",
  },
  {
    method: "GET",
    neutralPath: "/api/host/sites/:site/deployments",
    okouPath: "/api/okou/host/sites/:site/deployments",
    zeroPath: "/api/zero/host/sites/:site/deployments",
  },
];

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function requireSourceRoute(migrated: MigratedRoute): RouteEntry {
  const source = ROUTES.find(({ route }) => {
    return (
      route.method === migrated.method && route.path === migrated.neutralPath
    );
  });
  if (!source) {
    throw new Error(
      `Expected a route serving ${migrated.method} ${migrated.neutralPath}`,
    );
  }
  return source;
}

// Per-endpoint behaviour is covered through the endpoints themselves. This file
// asserts what no endpoint can: after the move, the two branded paths released
// CLI builds still call reach the same handler as the neutral path a current
// build calls.
describe("migrated goal and hosted-site paths", () => {
  const registeredRoutes = withMigratedBrandedPaths(
    withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
  );

  it("serves the neutral and both branded forms with the declaring handler", () => {
    for (const migrated of MIGRATED_ROUTES) {
      const source = requireSourceRoute(migrated);
      const paths = [
        migrated.neutralPath,
        migrated.okouPath,
        migrated.zeroPath,
      ];

      for (const path of paths) {
        const key = `${migrated.method} ${path}`;
        const matches = registeredRoutes.filter((entry) => {
          return routeKey(entry) === key;
        });
        expect(matches, `Missing registration for ${key}`).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(`Missing registration for ${key}`);
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path });
        // A row in `MIGRATED_BRANDED_PATHS` is compatibility promised on
        // purpose, so none of these may reach the fallback report.
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
    }
  });

  // Why the table is needed at all: the blanket expansion produces no branded
  // path once a contract declares the neutral form, so without a row both
  // branded paths above would simply stop resolving.
  it("leaves the neutral paths outside the namespace alias mechanism", () => {
    for (const { neutralPath } of MIGRATED_ROUTES) {
      expect(apiNamespaceAliasPaths(neutralPath)).toStrictEqual([neutralPath]);
    }
  });
});
