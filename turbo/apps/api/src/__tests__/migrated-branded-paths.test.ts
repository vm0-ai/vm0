import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import { ROUTES } from "../signals/route";
import { billingStatusRoutes } from "../signals/routes/billing-status";
import { featureSwitchesRoutes } from "../signals/routes/feature-switches";
import { orgReadRoutes } from "../signals/routes/org-read";
import { slackChannelsRoutes } from "../signals/routes/slack-channels";
import { slackConnectRoutes } from "../signals/routes/slack-connect";
import { slackOauthRoutes } from "../signals/routes/slack-oauth";
import { voiceIoQuotaRoutes } from "../signals/routes/voice-io-quota";
import {
  assertUniqueRouteRegistrations,
  type RouteEntry,
  withApiNamespaceAliases,
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
  "/api/me/model-providers": [
    "/api/okou/me/model-providers",
    "/api/zero/me/model-providers",
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
  // #28415
  // #28416
  // #28419
  // #28420: chat-thread drafts and unreads, agent/thread indicators, and signup
  // attribution.
  "/api/attribution/signup": [
    "/api/okou/attribution/signup",
    "/api/zero/attribution/signup",
  ],
  "/api/chat-thread-drafts": [
    "/api/okou/chat-thread-drafts",
    "/api/zero/chat-thread-drafts",
  ],
  "/api/chat-thread-unreads": [
    "/api/okou/chat-thread-unreads",
    "/api/zero/chat-thread-unreads",
  ],
  "/api/indicators": ["/api/okou/indicators", "/api/zero/indicators"],
  // #28422
  "/api/logs/:id": ["/api/okou/logs/:id", "/api/zero/logs/:id"],
  "/api/realtime/token": [
    "/api/okou/realtime/token",
    "/api/zero/realtime/token",
  ],
  // #28459: chat threads, chat events and search, shared threads,
  // per-thread browser sessions and goals, thread workflow automations,
  // queue position, and the X image share.
  "/api/chat-threads": ["/api/okou/chat-threads", "/api/zero/chat-threads"],
  "/api/chat-threads/:id": [
    "/api/okou/chat-threads/:id",
    "/api/zero/chat-threads/:id",
  ],
  "/api/chat-threads/:id/draft": [
    "/api/okou/chat-threads/:id/draft",
    "/api/zero/chat-threads/:id/draft",
  ],
  "/api/chat-threads/:id/mark-read": [
    "/api/okou/chat-threads/:id/mark-read",
    "/api/zero/chat-threads/:id/mark-read",
  ],
  "/api/chat-threads/:id/pin": [
    "/api/okou/chat-threads/:id/pin",
    "/api/zero/chat-threads/:id/pin",
  ],
  "/api/chat-threads/:threadId/artifacts": [
    "/api/okou/chat-threads/:threadId/artifacts",
    "/api/zero/chat-threads/:threadId/artifacts",
  ],
  "/api/chat-threads/:threadId/browser": [
    "/api/okou/chat-threads/:threadId/browser",
    "/api/zero/chat-threads/:threadId/browser",
  ],
  "/api/chat-threads/:threadId/event-rows": [
    "/api/okou/chat-threads/:threadId/event-rows",
    "/api/zero/chat-threads/:threadId/event-rows",
  ],
  "/api/chat-threads/:threadId/event-snapshot": [
    "/api/okou/chat-threads/:threadId/event-snapshot",
    "/api/zero/chat-threads/:threadId/event-snapshot",
  ],
  "/api/chat-threads/:threadId/workflow-automations": [
    "/api/okou/chat-threads/:threadId/workflow-automations",
    "/api/zero/chat-threads/:threadId/workflow-automations",
  ],
  "/api/chat-threads/events": [
    "/api/okou/chat-threads/events",
    "/api/zero/chat-threads/events",
  ],
  "/api/chat-threads/snapshot": [
    "/api/okou/chat-threads/snapshot",
    "/api/zero/chat-threads/snapshot",
  ],
  "/api/chat/events": ["/api/okou/chat/events", "/api/zero/chat/events"],
  // #28457: the billing surface.
  "/api/billing/status": [
    "/api/okou/billing/status",
    "/api/zero/billing/status",
  ],
  // #28466
  "/api/computer-use/audit-events": [
    "/api/okou/computer-use/audit-events",
    "/api/zero/computer-use/audit-events",
  ],
  "/api/computer-use/heartbeat": [
    "/api/okou/computer-use/heartbeat",
    "/api/zero/computer-use/heartbeat",
  ],
  "/api/computer-use/host/commands/:commandId/complete": [
    "/api/okou/computer-use/host/commands/:commandId/complete",
    "/api/zero/computer-use/host/commands/:commandId/complete",
  ],
  "/api/computer-use/host/commands/next": [
    "/api/okou/computer-use/host/commands/next",
    "/api/zero/computer-use/host/commands/next",
  ],
  "/api/computer-use/host/stop": [
    "/api/okou/computer-use/host/stop",
    "/api/zero/computer-use/host/stop",
  ],
  "/api/computer-use/hosts": [
    "/api/okou/computer-use/hosts",
    "/api/zero/computer-use/hosts",
  ],
  "/api/computer-use/hosts/start": [
    "/api/okou/computer-use/hosts/start",
    "/api/zero/computer-use/hosts/start",
  ],
  // #28423
  "/api/integrations/slack": [
    "/api/okou/integrations/slack",
    "/api/zero/integrations/slack",
  ],
  "/api/integrations/slack/connect": [
    "/api/okou/integrations/slack/connect",
    "/api/zero/integrations/slack/connect",
  ],
  "/api/integrations/slack/message": [
    "/api/okou/integrations/slack/message",
    "/api/zero/integrations/slack/message",
  ],
  "/api/integrations/slack/upload-file/complete": [
    "/api/okou/integrations/slack/upload-file/complete",
    "/api/zero/integrations/slack/upload-file/complete",
  ],
  "/api/integrations/slack/upload-file/init": [
    "/api/okou/integrations/slack/upload-file/init",
    "/api/zero/integrations/slack/upload-file/init",
  ],
  "/api/integrations/slack/upload-file/materialize": [
    "/api/okou/integrations/slack/upload-file/materialize",
    "/api/zero/integrations/slack/upload-file/materialize",
  ],
  // #28460: the connector catalog, the connector connections, the custom
  // connectors, the model provider connections, and the user permission grants.
  "/api/connector-catalog/:connectorSlug": [
    "/api/okou/connector-catalog/:connectorSlug",
    "/api/zero/connector-catalog/:connectorSlug",
  ],
  "/api/connector-catalog/status": [
    "/api/okou/connector-catalog/status",
    "/api/zero/connector-catalog/status",
  ],
  "/api/custom-connectors": [
    "/api/okou/custom-connectors",
    "/api/zero/custom-connectors",
  ],
  // #28464: the Slack, Teams, and Feishu connect and OAuth-start routes. The
  // paths a provider console holds are not in this slice and stay branded;
  // they are covered by `provider-console-paths.test.ts`. #30812 removed
  // `slack/oauth/connect`: unlike its `slack/oauth/install` sibling, no page
  // publishes a connect link, and the crawlers that keep finding the branded
  // install form found no form of connect in the same window.
  "/api/slack/channels": [
    "/api/okou/slack/channels",
    "/api/zero/slack/channels",
  ],
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
  // reads.
  "/api/feature-switches": [
    "/api/okou/feature-switches",
    "/api/zero/feature-switches",
  ],
  "/api/model-policies": [
    "/api/okou/model-policies",
    "/api/zero/model-policies",
  ],
  "/api/org": ["/api/okou/org", "/api/zero/org"],
  // #28461
  "/api/agents/:id": ["/api/okou/agents/:id", "/api/zero/agents/:id"],
  "/api/agents/:id/custom-connectors": [
    "/api/okou/agents/:id/custom-connectors",
    "/api/zero/agents/:id/custom-connectors",
  ],
  "/api/agents/:id/draft": [
    "/api/okou/agents/:id/draft",
    "/api/zero/agents/:id/draft",
  ],
  "/api/agents/:id/user-connectors": [
    "/api/okou/agents/:id/user-connectors",
    "/api/zero/agents/:id/user-connectors",
  ],
  "/api/workflows": ["/api/okou/workflows", "/api/zero/workflows"],
  // #28545 moved the Teams OAuth callback off `FINAL_PROVIDER_CONSOLE_PATHS`
  // once the Microsoft consoles held the final URL, and the slice has no rows
  // left. #28917 removed the Teams bot ingress, whose branded forms nothing
  // holds once the Azure Bot messaging endpoint moved, and #30812 removed the
  // callback. `/api/zero/teams/oauth/callback` was emitted on purpose by the
  // VM0 brand, which made it a producer target rather than drain-window
  // compatibility and is why #28917 kept it against its own inventory; #30667
  // unified that producer onto the canonical path, and a `redirect_uri` is
  // computed per request, so the deploy bounded the branded form to
  // authorizations already in flight.
  // #28463: avatar video, banking, browser authorization requests, inbound
  // email, the GitHub user-connect start, mail drafts, people search,
  // presentation templates, the Strapi webhook, uploads, video-io, voice-io and
  // the web file reads.
  "/api/voice-io/quota": [
    "/api/okou/voice-io/quota",
    "/api/zero/voice-io/quota",
  ],
  "/api/voice-io/speech": [
    "/api/okou/voice-io/speech",
    "/api/zero/voice-io/speech",
  ],
  // #28544: the two Feishu routes that left `FINAL_PROVIDER_CONSOLE_PATHS`.
  // Both branded forms used to be the declared paths, so these rows are the
  // only thing registering them now — the events one is what keeps the two
  // production Feishu installations delivering to the URL each of them holds in
  // its own Feishu app console.
  "/api/webhooks/feishu/events/:installationId": [
    "/api/okou/feishu/events/:installationId",
    "/api/zero/feishu/events/:installationId",
  ],
  // #28565: the connector-account reads and writes and the managed SocialKit
  // request, the two contracts that were added while #28278 was in flight and
  // so appeared in no slice's inventory.
  // #28600 added the Slack OAuth callback and the three inbound Slack webhooks,
  // the last contracts to leave the brand namespace, and #30668 removed all
  // four once their producers moved: the Slack app console now holds the
  // neutral webhook URLs, and `routes/slack-oauth.ts` emits the neutral
  // callback as its `redirect_uri`.
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

// `withApiNamespaceAliases` derives a branded route's canonical namespace and
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

  // Pins the order `createAppWithRoutes` composes the two stages in. A row
  // names a finished registration, so producing the branded paths before the
  // blanket expansion would feed `/api/okou/synthetic/thing` back into it and
  // derive its sibling namespace a second time.
  it("registers each branded path once only when applied after the expansion", () => {
    const composed = withMigratedBrandedPaths(
      withApiNamespaceAliases([NEUTRAL_ROUTE]),
      MIGRATED_TABLE,
    );
    const reversed = withApiNamespaceAliases(
      withMigratedBrandedPaths([NEUTRAL_ROUTE], MIGRATED_TABLE),
    );

    expect(() => {
      assertUniqueRouteRegistrations(composed);
    }).not.toThrow();
    expect(() => {
      assertUniqueRouteRegistrations(reversed);
    }).toThrow(
      "Duplicate API route registration: POST /api/okou/synthetic/thing",
    );
  });

  // The failure a migration slice would otherwise take to production: the
  // contract moves, every mechanism assertion still holds, and both branded
  // paths 404 for callers running a released build. A row is the way out, and
  // adding one has to be deliberate.
  //
  // Since #28701 the expansion no longer derives an unlisted `/api/zero/**`
  // path, so a branded contract owes its legacy form to a table row even before
  // the move. The canonical form is what the move itself drops.
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
    const registered = withMigratedBrandedPaths(
      withApiNamespaceAliases(ROUTES),
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
        }
      }
    }
  });

  // The #28423 twin: the integration control plane, driven through the same
  // production app factory. The registration assertion above rebuilds the
  // composition itself and so cannot see how `createAppWithRoutes` wires it —
  // if `withMigratedBrandedPaths` were dropped from or reordered in that chain,
  // every branded integration path would 404 here while that assertion still
  // passed. Requests are unauthenticated, so the status is whatever the auth
  // layer returns; the point is that all three forms reach the same handler.
  it("serves the migrated integration paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    // One GET per contract file this slice moved that still has a row, written
    // out rather than read back from `MIGRATED_BRANDED_PATHS`. #28917 removed
    // the Feishu and Strapi connect rows on zero-traffic evidence and #28916
    // removed the Teams connect row on cutover evidence, so those three are no
    // longer driven here.
    const families = [
      { routes: slackConnectRoutes, suffix: "integrations/slack/connect" },
    ];

    for (const { routes, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`);
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

  // The #28463 twin of the two assertions above. A row is matched on
  // `entry.route.path` alone. Every branded path below exists only because of
  // a table row, and the request goes through the app factory production wires,
  // so a row that never reaches the registration chain fails here rather than
  // 404ing a released CLI or platform build. The POST arm this loop used to
  // carry went with `uploads/prepare` in #28974 and `web/file-url` went with
  // #28916, so the loop is down to the one voice-io GET and the request builder
  // no longer branches on a method.
  it("serves the migrated product paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const endpoints = [
      { routes: voiceIoQuotaRoutes, suffix: "voice-io/quota" },
    ] as const;

    for (const { routes, suffix } of endpoints) {
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
        withMigratedBrandedPaths(withApiNamespaceAliases(ROUTES)),
      );
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
  // producer moved and left 58, and #30812 kept when it took the Teams OAuth
  // callback and the Slack connect start and left 56. None of them left a case
  // asserting the removed rows now 404: `docs/fallback.md` section 1 rules that
  // class out,
  // and the route table already proves the registration is gone.
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
    const MIGRATED_BRANDED_ROW_COUNT = 56;

    expect(Object.keys(MIGRATED_ROUTE_PATHS)).toHaveLength(
      MIGRATED_BRANDED_ROW_COUNT,
    );
  });

  // The #28457 twin of the two assertions above, for the billing slice. Every
  // caller of these routes in this repository derives its URL from the
  // contract, so a request-level case is the only place a dropped row shows
  // up as the 404 a released client would get. Requests are unauthenticated,
  // so the status is whatever the auth layer returns — the point is that all
  // three forms reach the same handler instead of falling through to 404.
  it("serves the migrated billing paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: billingStatusRoutes, method: "GET", suffix: "billing/status" },
    ] as const;

    for (const { routes, method, suffix } of families) {
      const app = createAppWithRoutes({ signal: context.signal, routes });

      async function statusFor(path: string): Promise<number> {
        const response = await app.request(`${REQUEST_ORIGIN}${path}`, {
          method,
          headers: { "content-type": "application/json" },
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

  // The #28464 twin of the two assertions above, driven through the app factory
  // production uses rather than over the route table. Every path is a GET a
  // released web build, or an install link already sitting in a Slack message,
  // still asks for. The status is whatever the handler returns without
  // credentials or provider configuration; the point is that all three forms
  // reach the same handler instead of falling through to 404. #30812 dropped
  // `slack/oauth/connect` from the list, because no page publishes a connect
  // link for anyone to be holding.
  it("serves the migrated IM connect paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: slackChannelsRoutes, suffix: "slack/channels" },
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
  // installed desktop build hardcodes `/api/okou/org` and
  // `/api/okou/feature-switches` rather than deriving them from a contract, and
  // it has no expiry window, so these are the two rows a dropped registration
  // would strand longest. Requests are unauthenticated, so the status is
  // whatever the auth layer returns — the point is that all three forms reach
  // the same handler instead of falling through to 404.
  it("serves the migrated org and feature-switch paths through the production app factory", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });

    const families = [
      { routes: orgReadRoutes, suffix: "org" },
      { routes: featureSwitchesRoutes, suffix: "feature-switches" },
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

  // #28545's twin used to sit here, the one slice whose branded forms a
  // provider console held rather than a released client. #28917 removed the
  // slice's bot row once the Azure Bot messaging endpoint had been repointed at
  // the neutral path, and #30812 removed the callback once #30667 had unified
  // `callbackRedirectUri` onto the canonical path — a `redirect_uri` is
  // computed per request, so the deploy bounded the branded form to
  // authorizations already in flight. The slice has no rows left, so there is
  // nothing for this case to drive.

  // The synthetic routes are not in the production `MIGRATED_BRANDED_PATHS`, so
  // this app registers only what the two contracts declare and what the
  // expansion derives from them. Since #28701 that no longer includes the
  // legacy form of the branded contract, which is why the last status is a 404
  // rather than the third 200 this test asserted while the fallback existed.
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
