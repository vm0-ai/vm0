import { ROUTES } from "../signals/route";
import {
  type RouteEntry,
  withApiNamespaceAliases,
  withFinalProviderConsolePaths,
  withMigratedBrandedPaths,
} from "../signals/route-entry";

interface MigratedRoute {
  readonly method: "GET" | "POST";
  readonly neutralPath: string;
  readonly brandedPaths: readonly [string, string];
}

// The thirteen routes #28418 moves off the brand namespace, each with the two
// branded paths a released caller still holds. Restated literally rather than
// derived from `apiNamespaceAliasPaths` or read back from
// `MIGRATED_BRANDED_PATHS`: that function returns a neutral path unchanged, so
// an expectation derived from it asserts nothing about the registrations this
// move drops, which is the whole failure this file exists to catch.
const MIGRATED_ROUTES: readonly MigratedRoute[] = [
  {
    method: "POST",
    neutralPath: "/api/browsers",
    brandedPaths: ["/api/okou/browsers", "/api/zero/browsers"],
  },
  {
    method: "GET",
    neutralPath: "/api/browsers/current",
    brandedPaths: ["/api/okou/browsers/current", "/api/zero/browsers/current"],
  },
  {
    method: "POST",
    neutralPath: "/api/browsers/lease",
    brandedPaths: ["/api/okou/browsers/lease", "/api/zero/browsers/lease"],
  },
  {
    method: "POST",
    neutralPath: "/api/browsers/use",
    brandedPaths: ["/api/okou/browsers/use", "/api/zero/browsers/use"],
  },
  {
    method: "POST",
    neutralPath: "/api/finance/chart",
    brandedPaths: ["/api/okou/finance/chart", "/api/zero/finance/chart"],
  },
  {
    method: "POST",
    neutralPath: "/api/finance/profile",
    brandedPaths: ["/api/okou/finance/profile", "/api/zero/finance/profile"],
  },
  {
    method: "POST",
    neutralPath: "/api/finance/quote",
    brandedPaths: ["/api/okou/finance/quote", "/api/zero/finance/quote"],
  },
  {
    method: "POST",
    neutralPath: "/api/finance/search",
    brandedPaths: ["/api/okou/finance/search", "/api/zero/finance/search"],
  },
  {
    method: "GET",
    neutralPath: "/api/mcp-connectors",
    brandedPaths: ["/api/okou/mcp-connectors", "/api/zero/mcp-connectors"],
  },
  {
    method: "POST",
    neutralPath: "/api/seo/backlinks-summary",
    brandedPaths: [
      "/api/okou/seo/backlinks-summary",
      "/api/zero/seo/backlinks-summary",
    ],
  },
  {
    method: "POST",
    neutralPath: "/api/seo/keyword-ideas",
    brandedPaths: [
      "/api/okou/seo/keyword-ideas",
      "/api/zero/seo/keyword-ideas",
    ],
  },
  {
    method: "POST",
    neutralPath: "/api/seo/ranked-keywords",
    brandedPaths: [
      "/api/okou/seo/ranked-keywords",
      "/api/zero/seo/ranked-keywords",
    ],
  },
  {
    method: "POST",
    neutralPath: "/api/seo/serp",
    brandedPaths: ["/api/okou/seo/serp", "/api/zero/seo/serp"],
  },
];

function routeKey(entry: RouteEntry): string {
  return `${entry.route.method} ${entry.route.path}`;
}

function neutralKey(migrated: MigratedRoute): string {
  return `${migrated.method} ${migrated.neutralPath}`;
}

function requireSourceRoute(migrated: MigratedRoute): RouteEntry {
  const key = neutralKey(migrated);
  const source = ROUTES.find((entry) => {
    return routeKey(entry) === key;
  });
  if (!source) {
    throw new Error(`Expected a contract declaring ${key}`);
  }
  return source;
}

// Per-endpoint behaviour is covered through the endpoints themselves. This file
// asserts the property no endpoint can express: over the whole route table,
// each of these thirteen routes now answers on its neutral path and still
// answers on both of the branded paths it answered on before the move.
describe("brand namespace migration for browser, finance, SEO, and MCP routes", () => {
  const registeredRoutes = withMigratedBrandedPaths(
    withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
  );

  it("declares the neutral path for every moved route", () => {
    const declaredKeys = new Set(ROUTES.map(routeKey));

    expect(
      MIGRATED_ROUTES.map(neutralKey).filter((key) => {
        return !declaredKeys.has(key);
      }),
    ).toStrictEqual([]);
  });

  it("serves the neutral path and both branded paths with the same handler", () => {
    for (const migrated of MIGRATED_ROUTES) {
      const source = requireSourceRoute(migrated);

      for (const path of [migrated.neutralPath, ...migrated.brandedPaths]) {
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
        // A `MIGRATED_BRANDED_PATHS` row is compatibility promised on purpose,
        // so none of these may reach the unlisted-legacy-path report.
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
    }
  });

  // The move must not leave a moved route reachable at anything but these three
  // paths, which is what catches a stale row naming a path the contract never
  // served.
  it("registers a moved route at exactly those three paths", () => {
    for (const migrated of MIGRATED_ROUTES) {
      const source = requireSourceRoute(migrated);

      expect(
        registeredRoutes
          .filter((entry) => {
            return entry.handler === source.handler;
          })
          .map((entry) => {
            return entry.route.path;
          })
          .sort(),
      ).toStrictEqual([migrated.neutralPath, ...migrated.brandedPaths].sort());
    }
  });
});
