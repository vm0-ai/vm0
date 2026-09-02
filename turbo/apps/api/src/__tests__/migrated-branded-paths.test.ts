import { brandedApiNamespace } from "@okouai/api-contracts/contracts/api-namespaces";
import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import { ROUTES } from "../signals/route";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
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

// Input to the mechanism, never an expectation: every expected path below is
// written out again inside the test that asserts it.
const MIGRATED_TABLE: Readonly<Record<string, readonly string[]>> = {
  "/api/synthetic/thing": [
    "/api/okou/synthetic/thing",
    "/api/zero/synthetic/thing",
  ],
};

function registeredPaths(entries: readonly RouteEntry[]): readonly string[] {
  return entries.map((entry) => {
    return entry.route.path;
  });
}

// The paths a released caller of the synthetic route holds. Restated here
// rather than read back from the table, so this stays true when the
// registration that serves them disappears.
const BRANDED_PATHS_OWED = [
  "/api/okou/synthetic/thing",
  "/api/zero/synthetic/thing",
] as const;

// Every route a #28278 slice has moved off `/api/okou/**` and still answers on
// a branded path, keyed by the neutral path its contract declares now.
// Restated here rather than read back from `MIGRATED_BRANDED_PATHS`: the table
// is what a migration edits, so an expectation taken from it asserts nothing.
//
// The inventory is empty. #31088 removed the last six rows — `/api/org`,
// `/api/workflows`, `/api/logs/:id`, the two `desktop/updates` rows and
// `/api/slack/oauth/install` — so no route answers on a branded path any more.
// A slice that adds a row back has to restate it here, which is what the two
// cases over the production route table below are for.
const MIGRATED_ROUTE_PATHS: Readonly<Record<string, readonly string[]>> = {};

function missingBrandedPaths(
  routes: readonly RouteEntry[],
  brandedPaths: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  const registered = new Set(
    registeredPaths(withMigratedBrandedPaths(routes, brandedPaths)),
  );
  return BRANDED_PATHS_OWED.filter((path) => {
    return !registered.has(path);
  });
}

// A route is registered at the path its contract declares, which is why a
// contract that moves to its neutral path loses both branded registrations.
// This file covers the table that gives them back: what it registers, what it
// must not touch, and the migration mistake it exists to make loud. The
// synthetic cases drive that table directly and stay meaningful with the
// shipped one empty; the cases over the real route table are what a slice
// adding a row back has to satisfy.
describe("branded paths for migrated neutral routes", () => {
  const context = testContext();

  it("registers the neutral path and every branded path a row names", () => {
    const registered = withMigratedBrandedPaths(
      [NEUTRAL_ROUTE],
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
  // be a blanket expansion, and #28278 would have gained nothing.
  it("registers only itself for a neutral path no row names", () => {
    const registered = withMigratedBrandedPaths(
      [UNNAMED_ROUTE],
      MIGRATED_TABLE,
    );

    expect(registeredPaths(registered)).toStrictEqual(["/api/synthetic/other"]);
  });

  it("fails uniqueness when a row collides with a declared path", () => {
    const registered = withMigratedBrandedPaths(
      [NEUTRAL_ROUTE, BRANDED_ROUTE],
      MIGRATED_TABLE,
    );

    expect(() => {
      assertUniqueRouteRegistrations(registered);
    }).toThrow(
      "Duplicate API route registration: POST /api/okou/synthetic/thing",
    );
  });

  // The failure a migration slice would otherwise take to production: the
  // contract moves, every mechanism assertion still holds, and both branded
  // paths 404 for callers running a released build. A row is the way out, and
  // adding one has to be deliberate.
  //
  // A route is registered only at the path its contract declares, so a branded
  // contract owes its legacy form to a table row even before the move. The
  // canonical form is what the move itself drops.
  it("reports the branded paths a move to a neutral path drops", () => {
    const beforeMove = missingBrandedPaths([BRANDED_ROUTE], {});
    const movedWithoutRow = missingBrandedPaths([NEUTRAL_ROUTE], {});
    const movedWithRow = missingBrandedPaths([NEUTRAL_ROUTE], MIGRATED_TABLE);

    expect(beforeMove).toStrictEqual(["/api/zero/synthetic/thing"]);
    expect(movedWithoutRow).toStrictEqual([
      "/api/okou/synthetic/thing",
      "/api/zero/synthetic/thing",
    ]);
    expect(movedWithRow).toStrictEqual([]);
  });

  // The synthetic cases above cover the mechanism; this runs the real route
  // table through the composition production registers. While the inventory
  // held rows, it asserted each one was served on its neutral path and on both
  // branded forms, so a moved contract that lost its rows failed here rather
  // than 404ing a released caller. The inventory is empty now, so the property
  // it pins is the whole-table one the rows were exceptions to: the
  // composition registers a branded path for nothing.
  //
  // Read off the composition rather than off the table, so it also fails if a
  // contract starts declaring a branded path again.
  it("registers no branded path for any route in the production table", () => {
    expect(Object.keys(MIGRATED_ROUTE_PATHS)).toStrictEqual([]);

    const registered = withMigratedBrandedPaths(ROUTES);

    expect(
      registeredPaths(registered)
        .filter((path) => {
          return brandedApiNamespace(path) !== undefined;
        })
        .sort(),
    ).toStrictEqual([]);
    expect(registered).toHaveLength(ROUTES.length);
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
      assertUniqueRouteRegistrations(withMigratedBrandedPaths(ROUTES));
    }).not.toThrow();
  });

  // A count, restated here as a literal, over the inventory above. While the
  // inventory held rows it proved the inventory itself was complete, so a
  // change that dropped a still-needed row failed a test instead of passing
  // because nothing enumerated it. That is the guard every removal from #28709
  // onward kept as the table went from 314 rows to six, and #31088 kept when it
  // took the last six.
  //
  // At zero it still carries that direction: the count is what a slice adding a
  // row back has to raise deliberately, with the evidence #26701's gate wants.
  // None of those removals left a case asserting the removed rows now 404 —
  // `docs/fallback.md` section 1 rules that class out, and the case above
  // already proves the composition registers no branded path.
  it("holds the branded rows this suite has evidence for and no others", () => {
    const MIGRATED_BRANDED_ROW_COUNT = 0;

    expect(Object.keys(MIGRATED_ROUTE_PATHS)).toHaveLength(
      MIGRATED_BRANDED_ROW_COUNT,
    );
  });

  // Two app-factory twins used to sit here, one per family with a row left:
  // #28464's Slack install link and #28462's `/api/org`. Each drove all three
  // forms through the app factory production uses and asserted they answered
  // identically rather than falling through to 404. #31088 removed both rows,
  // so neither has a subject, and replacing them with the opposite assertion is
  // the tombstone `docs/fallback.md` section 1 rules out — the case above
  // already proves the composition registers no branded path.
  //
  // #28545's twin, the one slice whose branded forms a provider console held
  // rather than a released client, had already gone the same way: #28917
  // removed the bot row once the Azure Bot messaging endpoint was repointed at
  // the neutral path, and #30812 the callback once #30667 unified
  // `callbackRedirectUri` onto the canonical path.

  // The synthetic routes are not in the production `MIGRATED_BRANDED_PATHS`, so
  // this app registers exactly what the two contracts declare. Nothing derives
  // the legacy form of the branded contract, which is why the last status is a
  // 404 rather than the third 200 this test asserted while the fallback
  // existed.
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

    expect(statuses).toStrictEqual([200, 200, 404]);
  });
});
