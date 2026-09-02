import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import { ROUTES } from "../signals/route";
import { orgReadRoutes } from "../signals/routes/org-read";
import { slackOauthRoutes } from "../signals/routes/slack-oauth";
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

// Every route a #28278 slice has moved off `/api/okou/**`, keyed by the
// neutral path its contract declares now and holding the two branded paths
// released callers still reach it at. Restated here rather than read back from
// `MIGRATED_BRANDED_PATHS`: the table is what a migration edits, so an
// expectation taken from it asserts nothing. Each slice appends its own rows.
const MIGRATED_ROUTE_PATHS: Readonly<Record<string, readonly string[]>> = {
  // #28422
  "/api/logs/:id": ["/api/okou/logs/:id", "/api/zero/logs/:id"],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes. The
  // paths a provider console holds are not in this slice and stay branded;
  // they are covered by `provider-console-paths.test.ts`. #30812 removed
  // `slack/oauth/connect` and #30807 removed `slack/channels`, leaving the one
  // OAuth-start path a marketing landing page published.
  "/api/slack/oauth/install": [
    "/api/okou/slack/oauth/install",
    "/api/zero/slack/oauth/install",
  ],
  // #28465. Keys hold their path parameters verbatim, because the table is
  // matched against `entry.route.path` rather than an expanded request path.
  "/api/desktop/updates/:channel/:platform/:arch/dmg": [
    "/api/okou/desktop/updates/:channel/:platform/:arch/dmg",
    "/api/zero/desktop/updates/:channel/:platform/:arch/dmg",
  ],
  "/api/desktop/updates/:channel/:platform/:arch/release": [
    "/api/okou/desktop/updates/:channel/:platform/:arch/release",
    "/api/zero/desktop/updates/:channel/:platform/:arch/release",
  ],
  // #28462: feature switches, model policies, org model providers and their
  // device-auth sessions, the org profile and membership routes, and the usage
  // reads. #30804 removed `feature-switches` and #30807 removed
  // `model-policies`, leaving the org profile.
  "/api/org": ["/api/okou/org", "/api/zero/org"],
  // #28461. #30807 removed the four per-agent rows.
  "/api/workflows": ["/api/okou/workflows", "/api/zero/workflows"],
  // #28544: the two Feishu routes that left `FINAL_PROVIDER_CONSOLE_PATHS`.
  // #28709 removed the OAuth callback, and #31068 removed the events row as an
  // owner decision rather than on evidence: both production installations still
  // hold the branded URL in their own Feishu app console, so removing it stops
  // their deliveries, and the owner accepted that after notifying both holders.
  // #28565: the connector-account reads and writes and the managed SocialKit
  // request, the two contracts that were added while #28278 was in flight and
  // so appeared in no slice's inventory.
  // #28600 added the Slack OAuth callback and the three inbound Slack webhooks,
  // the last contracts to leave the brand namespace, and #30668 removed all
  // four once their producers moved: the Slack app console now holds the
  // neutral webhook URLs, and `routes/slack-oauth.ts` emits the neutral
  // callback as its `redirect_uri`.
  // #30807 then removed forty-four rows as a class: no source in `turbo/`
  // emits a branded literal outside tests, and the Computer Use family that an
  // installed Desktop build does hardcode had already been settled by #30804.
};

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
// must not touch, and the migration mistake it exists to make loud.
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
  // table through the composition production registers, so a moved contract
  // that lost its rows fails here rather than 404ing a released caller.
  it("serves every migrated route at its neutral path and both branded paths", () => {
    const registered = withMigratedBrandedPaths(ROUTES);

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
        }
      }
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
      assertUniqueRouteRegistrations(withMigratedBrandedPaths(ROUTES));
    }).not.toThrow();
  });

  // A count, restated here as a literal, over the inventory above. The
  // per-family cases prove that every row the inventory lists is served on both
  // branded forms; this proves the inventory itself is complete, so a later
  // change that removes a still-needed row fails a test instead of passing
  // because nothing enumerated it.
  //
  // That is the guard #28709 left behind when it took the table from 314 rows
  // to 184, #28711 kept when it took the 42 drained rows that left 142, #28917
  // kept when it took 53 more and left 89, #28974 kept when it took
  // `uploads/prepare` and left 88, #28916 kept when it took the 26 cut-over
  // rows that left 62, #30668 kept when it took the four Slack rows whose
  // producer moved and left 58, #30804 kept when it took the four Computer Use
  // host rows and `feature-switches` and left 53, #30812 kept when it took
  // the Teams OAuth callback and the Slack connect start and left 51, #30807
  // kept when it took forty-four rows as a class and left 7, and #31068 kept
  // when it took the Feishu events row and left 6. None of them left a case
  // asserting the removed rows now 404: `docs/fallback.md` section 1 rules that
  // class out, and the route table already proves the registration is gone.
  // What needs a test is the opposite direction — a row disappearing without
  // the request-log evidence #26701 requires — which is what this count and the
  // per-family cases catch.
  //
  // `MIGRATED_ROUTE_PATHS` carries every row. It used to be two short, because
  // the maps and weather cases owned `/api/maps/geocode` and
  // `/api/weather/current`; #28917 drained both families out of the table, so
  // those cases and the offset they needed are gone and the size below is the
  // whole table. Raise the number only with that evidence; an unexplained edit
  // here is the failure this is for.
  it("holds the branded rows this suite has evidence for and no others", () => {
    const MIGRATED_BRANDED_ROW_COUNT = 6;

    expect(Object.keys(MIGRATED_ROUTE_PATHS)).toHaveLength(
      MIGRATED_BRANDED_ROW_COUNT,
    );
  });

  // The #28464 twin of the two assertions above, driven through the app factory
  // production uses rather than over the route table. The one path left is an
  // install link already sitting in a Slack message, a bookmark or a search
  // index, which is the holder no deploy bounds. The status is whatever the
  // handler returns without credentials or provider configuration; the point is
  // that all three forms reach the same handler instead of falling through to
  // 404. #30812 dropped `slack/oauth/connect` from the list, because no page
  // publishes a connect link for anyone to be holding, and #30807 dropped
  // `slack/channels`, the one a released web build derived from a contract.
  it("serves the migrated IM connect paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: slackOauthRoutes, suffix: "slack/oauth/install" },
    ];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method: "GET",
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

  // The #28462 twin, driven through the same production app factory. An
  // installed desktop build hardcodes `/api/okou/org` rather than deriving it
  // from a contract, and a `CLI_PKG_URL`-pinned CLI was still reading
  // `/api/zero/org` when #30804 measured the table, so this is the row a
  // dropped registration would strand longest. That slice also covered
  // `feature-switches`, whose row #30804 retired, which is why only `org` is
  // exercised here now. Requests are unauthenticated, so the status is whatever
  // the auth layer returns — the point is that all three forms reach the same
  // handler instead of falling through to 404.
  it("serves the migrated org paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [{ routes: orgReadRoutes, suffix: "org" }];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method: "GET",
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

  // #28545's twin used to sit here, the one slice whose branded forms a
  // provider console held rather than a released client. #28917 removed the
  // slice's bot row once the Azure Bot messaging endpoint had been repointed at
  // the neutral path, and #30812 removed the callback once #30667 had unified
  // `callbackRedirectUri` onto the canonical path — a `redirect_uri` is
  // computed per request, so the deploy bounded the branded form to
  // authorizations already in flight. The slice has no rows left, so there is
  // nothing for this case to drive.

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
