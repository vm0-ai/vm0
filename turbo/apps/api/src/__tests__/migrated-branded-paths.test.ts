import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import { ROUTES } from "../signals/route";
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

// Synthetic contracts rather than real ones, so the mechanism assertions keep
// asserting the same thing as #28278 slices move real contracts in and out of
// `MIGRATED_BRANDED_PATHS`. The real table is covered separately at the end of
// this file, against a literal list of the paths that have moved.
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

// Every path #28278 has moved off the brand namespace, with the two branded
// forms released callers still hold. Written out rather than read back from
// `MIGRATED_BRANDED_PATHS` or expanded through `apiNamespaceAliasPaths`, which
// returns a neutral path unchanged and so cannot name what a moved route owes.
// Each migration slice appends its own paths here.
const MIGRATED_PRODUCTION_PATHS = [
  // #28422
  {
    neutral: "/api/artifacts/catalog",
    okou: "/api/okou/artifacts/catalog",
    zero: "/api/zero/artifacts/catalog",
  },
  {
    neutral: "/api/artifacts/catalog/:artifactId",
    okou: "/api/okou/artifacts/catalog/:artifactId",
    zero: "/api/zero/artifacts/catalog/:artifactId",
  },
  {
    neutral: "/api/logs",
    okou: "/api/okou/logs",
    zero: "/api/zero/logs",
  },
  {
    neutral: "/api/logs/:id",
    okou: "/api/okou/logs/:id",
    zero: "/api/zero/logs/:id",
  },
  {
    neutral: "/api/push-subscriptions",
    okou: "/api/okou/push-subscriptions",
    zero: "/api/zero/push-subscriptions",
  },
  {
    neutral: "/api/realtime/token",
    okou: "/api/okou/realtime/token",
    zero: "/api/zero/realtime/token",
  },
  {
    neutral: "/api/runs/:id",
    okou: "/api/okou/runs/:id",
    zero: "/api/zero/runs/:id",
  },
  {
    neutral: "/api/runs/:id/cancel",
    okou: "/api/okou/runs/:id/cancel",
    zero: "/api/zero/runs/:id/cancel",
  },
  {
    neutral: "/api/runs/:id/context",
    okou: "/api/okou/runs/:id/context",
    zero: "/api/zero/runs/:id/context",
  },
  {
    neutral: "/api/runs/:id/network",
    okou: "/api/okou/runs/:id/network",
    zero: "/api/zero/runs/:id/network",
  },
  {
    neutral: "/api/runs/:id/runner",
    okou: "/api/okou/runs/:id/runner",
    zero: "/api/zero/runs/:id/runner",
  },
  {
    neutral: "/api/runs/:id/telemetry/agent",
    okou: "/api/okou/runs/:id/telemetry/agent",
    zero: "/api/zero/runs/:id/telemetry/agent",
  },
  {
    neutral: "/api/runs/queue",
    okou: "/api/okou/runs/queue",
    zero: "/api/zero/runs/queue",
  },
] as const;

// The composition `createAppWithRoutes` applies, so the assertions below run
// over the registrations production actually serves.
function productionRegistrations(): readonly RouteEntry[] {
  return withMigratedBrandedPaths(
    withApiNamespaceAliases(withFinalProviderConsolePaths(ROUTES)),
  );
}

function registeredPaths(entries: readonly RouteEntry[]): readonly string[] {
  return entries.map((entry) => {
    return entry.route.path;
  });
}

function registrationsForPath(
  entries: readonly RouteEntry[],
  path: string,
): readonly RouteEntry[] {
  return entries.filter((entry) => {
    return entry.route.path === path;
  });
}

// The paths a released caller of the synthetic route holds. Restated here
// rather than read back from the table or from `apiNamespaceAliasPaths`, so
// this stays true when the registration that serves them disappears.
const BRANDED_PATHS_OWED = [
  "/api/okou/synthetic/thing",
  "/api/zero/synthetic/thing",
] as const;

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
      assertUniqueRouteRegistrations(productionRegistrations());
    }).not.toThrow();
  });

  it("registers every migrated route at its neutral path", () => {
    const registered = new Set(registeredPaths(productionRegistrations()));
    const missing = MIGRATED_PRODUCTION_PATHS.filter(({ neutral }) => {
      return !registered.has(neutral);
    });

    expect(missing).toStrictEqual([]);
  });

  // The failure #28278 would otherwise ship: a released CLI or browser build
  // still requests the branded path, so both forms have to keep answering with
  // the handler the neutral path now declares.
  it("keeps every migrated route answering on both branded paths", () => {
    const registrations = productionRegistrations();

    for (const { neutral, okou, zero } of MIGRATED_PRODUCTION_PATHS) {
      const sources = registrationsForPath(registrations, neutral);
      expect(sources, `Expected one route serving ${neutral}`).toHaveLength(1);
      const source = sources[0];
      if (!source) {
        throw new Error(`Expected one route serving ${neutral}`);
      }

      for (const branded of [okou, zero]) {
        const matches = registrationsForPath(registrations, branded);
        expect(matches, `Missing registration for ${branded}`).toHaveLength(1);
        const match = matches[0];
        if (!match) {
          throw new Error(`Missing registration for ${branded}`);
        }
        expect(match.handler).toBe(source.handler);
        expect(match.route).toStrictEqual({ ...source.route, path: branded });
        // A row is compatibility promised on purpose, so it must not reach the
        // unlisted-legacy-path report.
        expect(match.viaNamespaceAliasFallback).toBeUndefined();
      }
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
