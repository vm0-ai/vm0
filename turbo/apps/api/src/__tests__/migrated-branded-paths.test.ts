import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import { ROUTES } from "../signals/route";
import { imageRecognitionRoutes } from "../signals/routes/image-recognition";
import { scrapeRoutes } from "../signals/routes/scrape";
import { translationRoutes } from "../signals/routes/translation";
import { weatherRoutes } from "../signals/routes/weather";
import { webSearchRoutes } from "../signals/routes/web-search";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
  withFinalProviderConsolePaths,
  withMigratedBrandedPaths,
} from "../signals/route-entry";
import { testContext } from "./test-context";

const c = initContract();
const REQUEST_ORIGIN = "http://api.test";

// Synthetic contracts rather than real ones, so a later migration slice cannot
// quietly change what these mechanism tests assert. The shipped table is
// covered separately, against the real route table, further down.
const migrationContract = c.router({
  // The shape a migrated contract has: the neutral path it declares after
  // #28278 moves it off `/api/okou/**`.
  neutral: {
    method: "POST",
    path: "/api/synthetic/thing",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  // The same route before the move, and the collision a careless row causes.
  branded: {
    method: "POST",
    path: "/api/okou/synthetic/thing",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  // A neutral route no row names, standing in for the ~354 paths the table must
  // leave alone.
  unnamed: {
    method: "POST",
    path: "/api/synthetic/other",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  // A route `FINAL_PROVIDER_CONSOLE_PATHS` also acts on, before and after its
  // move, so both tables can be run over one pipeline.
  consoleBranded: {
    method: "POST",
    path: "/api/okou/feishu/events/:installationId",
    pathParams: z.object({ installationId: z.string() }),
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  consoleFinal: {
    method: "POST",
    path: "/api/webhooks/feishu/events/:installationId",
    pathParams: z.object({ installationId: z.string() }),
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
});

function servedHandler() {
  return computed(() => {
    return { status: 200 as const, body: { served: true as const } };
  });
}

// One handler per route, so asserting that a produced registration carries the
// declaring route's handler is a real assertion rather than a coincidence.
const NEUTRAL_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.neutral,
  handler: servedHandler(),
};
const BRANDED_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.branded,
  handler: servedHandler(),
};
const UNNAMED_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.unnamed,
  handler: servedHandler(),
};
const CONSOLE_BRANDED_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.consoleBranded,
  handler: servedHandler(),
};
const CONSOLE_FINAL_ROUTE: Readonly<RouteEntry> = {
  route: migrationContract.consoleFinal,
  handler: servedHandler(),
};

// Input to the mechanism, never an expectation: every expected path below is
// written out again inside the test that asserts it.
const MIGRATED_TABLE: Readonly<Record<string, readonly string[]>> = {
  "/api/synthetic/thing": [
    "/api/okou/synthetic/thing",
    "/api/zero/synthetic/thing",
  ],
};

const MIGRATED_CONSOLE_TABLE: Readonly<Record<string, readonly string[]>> = {
  "/api/webhooks/feishu/events/:installationId": [
    "/api/okou/feishu/events/:installationId",
    "/api/zero/feishu/events/:installationId",
  ],
};

// The seven operations #28417 moved off `/api/okou/maps/**`, written out rather
// than read from `mapsContract` or `MIGRATED_BRANDED_PATHS`, so dropping a
// contract path or a table row fails the test that uses this.
const MAPS_OPERATIONS = [
  "geocode",
  "reverse-geocode",
  "directions",
  "places/search",
  "places/details",
  "osm/download",
  "osm/render",
] as const;

// The five operations #28357 moved off `/api/okou/weather/**`, written out
// rather than read from `weatherContract` or `MIGRATED_BRANDED_PATHS`, so
// dropping a contract path or a table row fails the test that uses this.
const WEATHER_OPERATIONS = [
  "current",
  "forecast/hourly",
  "forecast/daily",
  "history/hourly",
  "air-quality/current",
] as const;

function registeredPaths(entries: readonly RouteEntry[]): readonly string[] {
  return entries.map((entry) => {
    return entry.route.path;
  });
}

// The paths a released caller of the synthetic route holds. Restated here
// rather than read back from the table or from `apiNamespaceAliasPaths`, so
// this stays true when the registration that serves them disappears.
const BRANDED_PATHS_OWED = [
  "/api/okou/synthetic/thing",
  "/api/zero/synthetic/thing",
] as const;

// Every route a #28278 slice has moved off `/api/okou/**`, keyed by the
// neutral path its contract declares now and holding the two branded paths
// released callers still reach it at. Restated here rather than read back
// from `MIGRATED_BRANDED_PATHS` or derived from `apiNamespaceAliasPaths`: the
// table is what a migration edits, and the function returns a neutral path
// unchanged, so an expectation taken from either asserts nothing. Each slice
// appends its own rows.
const MIGRATED_ROUTE_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28421
  "/api/me/model-provider-accounts/:id": [
    "/api/okou/me/model-provider-accounts/:id",
    "/api/zero/me/model-provider-accounts/:id",
  ],
  "/api/me/model-provider-accounts/:id/activate": [
    "/api/okou/me/model-provider-accounts/:id/activate",
    "/api/zero/me/model-provider-accounts/:id/activate",
  ],
  "/api/me/model-provider-accounts/:id/subscription-reset": [
    "/api/okou/me/model-provider-accounts/:id/subscription-reset",
    "/api/zero/me/model-provider-accounts/:id/subscription-reset",
  ],
  "/api/me/model-providers": [
    "/api/okou/me/model-providers",
    "/api/zero/me/model-providers",
  ],
  "/api/me/model-providers/:type": [
    "/api/okou/me/model-providers/:type",
    "/api/zero/me/model-providers/:type",
  ],
  "/api/me/model-providers/:type/subscription-reset": [
    "/api/okou/me/model-providers/:type/subscription-reset",
    "/api/zero/me/model-providers/:type/subscription-reset",
  ],
  "/api/onboarding/complete": [
    "/api/okou/onboarding/complete",
    "/api/zero/onboarding/complete",
  ],
  "/api/onboarding/status": [
    "/api/okou/onboarding/status",
    "/api/zero/onboarding/status",
  ],
  "/api/team": ["/api/okou/team", "/api/zero/team"],
  "/api/user-model-preference": [
    "/api/okou/user-model-preference",
    "/api/zero/user-model-preference",
  ],
  "/api/user-preferences": [
    "/api/okou/user-preferences",
    "/api/zero/user-preferences",
  ],
  // #28416
  "/api/recognize": ["/api/okou/recognize", "/api/zero/recognize"],
  "/api/scrape": ["/api/okou/scrape", "/api/zero/scrape"],
  "/api/translate": ["/api/okou/translate", "/api/zero/translate"],
  "/api/web-search": ["/api/okou/web-search", "/api/zero/web-search"],
};

function missingBrandedPaths(
  routes: readonly RouteEntry[],
  brandedPaths: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const registered = new Set(
    registeredPaths(
      withMigratedBrandedPaths(withApiNamespaceAliases(routes), brandedPaths),
    ),
  );
  return BRANDED_PATHS_OWED.filter((path) => {
    return !registered.has(path);
  });
}

// `withApiNamespaceAliases` derives a branded route's second namespace and
// leaves a neutral path alone, which is why a contract that moves to its
// neutral path loses both branded registrations. This file covers the table
// that gives them back: what it registers, what it must not touch, and the
// migration mistake it exists to make loud.
describe("branded paths for migrated neutral routes", () => {
  const context = testContext();

  it("registers the neutral path and every branded path a row names", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual([
      "/api/synthetic/thing",
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ]);
    for (const entry of registered) {
      expect(entry.handler).toBe(NEUTRAL_ROUTE.handler);
      expect(entry.route).toStrictEqual({
        ...NEUTRAL_ROUTE.route,
        path: entry.route.path,
      });
    }
  });

  // The table names paths one row at a time. If it ever derived them, it would
  // be a second blanket expansion, and #28278 would have gained nothing.
  it("registers only itself for a neutral path no row names", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([UNNAMED_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual(["/api/synthetic/other"]);
  });

  // A row is compatibility promised on purpose, so it must not reach the
  // unlisted-legacy-path report that `createAppWithRoutes` writes.
  it("marks nothing it registers as a namespace alias fallback", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(
      registered.map((entry) => {
        return entry.viaNamespaceAliasFallback;
      }),
    ).toStrictEqual([undefined, undefined, undefined]);
  });

  it("fails uniqueness when a row collides with a declared path", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE, BRANDED_ROUTE]),
      MIGRATED_TABLE,
    );

    expect(() => {
      assertUniqueRouteRegistrations(registered);
    }).toThrow(
      "Duplicate API route registration: POST /api/okou/synthetic/thing",
    );
  });

  it("keeps the console table's paths for a route no row names", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(
        withFinalProviderConsolePaths([CONSOLE_BRANDED_ROUTE]),
      ),
      MIGRATED_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual([
      "/api/okou/feishu/events/:installationId",
      "/api/zero/feishu/events/:installationId",
      "/api/webhooks/feishu/events/:installationId",
    ]);
  });

  // The same route once it has moved to the final console path. This also pins
  // the order the two tables run in: producing the branded paths before the
  // console table would feed `/api/okou/feishu/events/:installationId` back
  // into it and register the console path a second time.
  it("registers a migrated console route's branded paths exactly once", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(
        withFinalProviderConsolePaths([CONSOLE_FINAL_ROUTE]),
      ),
      MIGRATED_CONSOLE_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual([
      "/api/webhooks/feishu/events/:installationId",
      "/api/okou/feishu/events/:installationId",
      "/api/zero/feishu/events/:installationId",
    ]);
    expect(() => {
      assertUniqueRouteRegistrations(registered);
    }).not.toThrow();
  });

  // The failure a migration slice would otherwise take to production: the
  // contract moves, every mechanism assertion still holds, and both branded
  // paths 404 for callers running a released build. A row is the way out, and
  // adding one has to be deliberate.
  it("reports the branded paths a move to a neutral path drops", () => {
    const beforeMove = missingBrandedPaths([BRANDED_ROUTE], {});
    const movedWithoutRow = missingBrandedPaths([NEUTRAL_ROUTE], {});
    const movedWithRow = missingBrandedPaths([NEUTRAL_ROUTE], MIGRATED_TABLE);

    expect(beforeMove).toStrictEqual([]);
    expect(movedWithoutRow).toStrictEqual([
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ]);
    expect(movedWithRow).toStrictEqual([]);
  });

  // #28417 fills the table for maps. The contract declares the neutral paths,
  // so the blanket expansion no longer derives a branded form for them and
  // every branded maps path below exists only because of a table row. The paths
  // are written out here rather than derived from the table, so deleting a row
  // fails this test instead of changing what it asserts.
  it("serves the migrated maps routes on neutral and branded paths", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
    );

    function requireRoute(path: string): RouteEntry {
      const matches = registered.filter((entry) => {
        return entry.route.method === "POST" && entry.route.path === path;
      });
      const match = matches[0];
      if (!match) {
        throw new Error(`Missing maps registration for POST ${path}`);
      }
      expect(matches).toHaveLength(1);
      return match;
    }

    for (const operation of MAPS_OPERATIONS) {
      const neutral = requireRoute(`/api/maps/${operation}`);

      // One contract route behind all three paths, so a branded form cannot
      // drift into a second handler or a stale schema.
      for (const namespace of ["okou", "zero"]) {
        const brandedPath = `/api/${namespace}/maps/${operation}`;
        const branded = requireRoute(brandedPath);

        expect(branded.handler).toBe(neutral.handler);
        expect(branded.route).toStrictEqual({
          ...neutral.route,
          path: brandedPath,
        });
      }
    }
  });

  // The weather twin of the assertion above (#28357). Kept as its own test so a
  // failure names the family that regressed, and so the paths stay written out
  // per family rather than derived from the table under test.
  it("serves the migrated weather routes on neutral and branded paths", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
    );

    function requireRoute(path: string): RouteEntry {
      const matches = registered.filter((entry) => {
        return entry.route.method === "POST" && entry.route.path === path;
      });
      const match = matches[0];
      if (!match) {
        throw new Error(`Missing weather registration for POST ${path}`);
      }
      expect(matches).toHaveLength(1);
      return match;
    }

    for (const operation of WEATHER_OPERATIONS) {
      const neutral = requireRoute(`/api/weather/${operation}`);

      // One contract route behind all three paths, so a branded form cannot
      // drift into a second handler or a stale schema.
      for (const namespace of ["okou", "zero"]) {
        const brandedPath = `/api/${namespace}/weather/${operation}`;
        const branded = requireRoute(brandedPath);

        expect(branded.handler).toBe(neutral.handler);
        expect(branded.route).toStrictEqual({
          ...neutral.route,
          path: brandedPath,
        });
      }
    }
  });

  // The synthetic cases above cover the mechanism; this runs the real route
  // table through the composition production registers, so a moved contract
  // that lost its rows fails here rather than 404ing a released caller.
  it("serves every migrated route at its neutral path and both branded paths", () => {
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
    );

    for (const [neutral, brandedPaths] of Object.entries(
      MIGRATED_ROUTE_PATHS,
    )) {
      const declared = ROUTES.filter((entry) => {
        return entry.route.path === neutral;
      });
      expect(
        declared.length,
        `Expected a contract declaring ${neutral}`,
      ).toBeGreaterThan(0);

      for (const source of declared) {
        for (const path of [neutral, ...brandedPaths]) {
          const key = `${source.route.method} ${path}`;
          const matches = registered.filter((entry) => {
            return (
              entry.route.method === source.route.method &&
              entry.route.path === path
            );
          });
          expect(matches, `Missing registration for ${key}`).toHaveLength(1);
          const match = matches[0];
          if (!match) {
            throw new Error(`Missing registration for ${key}`);
          }
          expect(match.handler).toBe(source.handler);
          expect(match.route).toStrictEqual({ ...source.route, path });
          // A row is compatibility promised on purpose, so it must not be
          // reported as a gap the compatibility table missed.
          expect(match.viaNamespaceAliasFallback).toBeUndefined();
        }
      }

  // The #28416 twin of the weather assertion below: the four managed
  // web-content and model routes, driven through the same production app
  // factory. Kept per family so a failure names what regressed.
  it("serves the migrated web-content paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: imageRecognitionRoutes, suffix: "recognize" },
      { routes: scrapeRoutes, suffix: "scrape" },
      { routes: translationRoutes, suffix: "translate" },
      { routes: webSearchRoutes, suffix: "web-search" },
    ];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        return response.status;
      }

      const neutral = await statusFor(`/api/${suffix}`);
      const okou = await statusFor(`/api/okou/${suffix}`);
      const zero = await statusFor(`/api/zero/${suffix}`);

      expect({ suffix, neutral, okou, zero }).toStrictEqual({
        suffix,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });
    }
  });

  // Hono keeps both registrations for a duplicated path and answers with the
  // first, so a colliding row would take a handler over instead of failing.
  // The synthetic case above proves the error is raised; this one runs the real
  // route table through the composition production registers, so the slice that
  // adds a colliding row fails here rather than in production. Asserted over
  // the route table rather than inside `createAppWithRoutes`, because test apps
  // deliberately compose overlapping route slices and would fail an app-wide
  // assertion for reasons that have nothing to do with the table.
  it("keeps the production route table free of colliding registrations", () => {
    expect(() => {
      assertUniqueRouteRegistrations(
        withMigratedBrandedPaths(
          withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
        ),
      );
    }).not.toThrow();
  });

  // The route-table assertion above rebuilds the composition itself, so it
  // cannot see how `createAppWithRoutes` wires it. This one goes through the
  // app factory production uses: if `withMigratedBrandedPaths` were dropped
  // from or reordered in that chain, the branded weather paths would 404 here
  // while the table assertion still passed. Requests are unauthenticated, so
  // the status is whatever the auth layer returns — the point is that all
  // three forms reach the same handler instead of falling through to 404.
  it("serves the migrated weather paths through the production app factory", async () => {
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: weatherRoutes,
    });

    async function statusFor(path: string): Promise<number> {
      const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.status;
    }

    for (const operation of WEATHER_OPERATIONS) {
      const neutral = await statusFor(`/api/weather/${operation}`);
      const okou = await statusFor(`/api/okou/weather/${operation}`);
      const zero = await statusFor(`/api/zero/weather/${operation}`);

      expect({ operation, neutral, okou, zero }).toStrictEqual({
        operation,
        neutral,
        okou: neutral,
        zero: neutral,
      });
      expect(neutral).not.toBe(404);
    }
  });

  it("builds an app that serves every path it registers", async () => {
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: [NEUTRAL_ROUTE, BRANDED_ROUTE],
    });

    const paths = [
      "/api/synthetic/thing",
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ];
    const statuses: number[] = [];
    for (const path of paths) {
      const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      statuses.push(response.status);
    }

    expect(statuses).toStrictEqual([200, 200, 200]);
  });
});
