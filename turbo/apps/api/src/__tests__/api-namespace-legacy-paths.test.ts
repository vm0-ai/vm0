import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import type { RouteEntry } from "../signals/route-entry";
import { testContext } from "./test-context";

const c = initContract();
const REQUEST_ORIGIN = "http://api.test";

// `/api/slack/oauth/install` is a `MIGRATED_BRANDED_PATHS` key in
// `route-entry.ts`, so a contract declaring it is registered on both branded
// forms as well. The `__test` paths are named by no table, so they stand in for
// the branded contract paths #28701 stopped deriving a legacy form for and
// #30667 made unconditional.
//
// #30668 moved this subject off `/api/webhooks/slack/events`, whose row it
// retired once the Slack app console stopped posting to the branded forms. The
// install row is the opposite case and the reason it is the subject now: its
// branded URL was handed to people rather than emitted per request, so no
// deploy can drain it and the row outlives the ones a console held.
const namespaceContract = c.router({
  migrated: {
    method: "GET",
    path: "/api/slack/oauth/install",
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  unlisted: {
    method: "GET",
    path: "/api/okou/__test/namespace-alias",
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  unlistedById: {
    method: "GET",
    path: "/api/okou/__test/namespace-alias/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
});

const served$ = computed(() => {
  return { status: 200 as const, body: { served: true as const } };
});

const TEST_ROUTES: readonly RouteEntry[] = [
  { route: namespaceContract.migrated, handler: served$ },
  { route: namespaceContract.unlisted, handler: served$ },
  { route: namespaceContract.unlistedById, handler: served$ },
];

// The registration-level view of this is in `api-namespace-compatibility.test.ts`.
// This file drives the same rule through the app factory production uses, so a
// legacy path that stops being registered is also proven to answer 404 rather
// than to fall through to some other match.
describe("legacy API namespace paths", () => {
  const context = testContext();

  function createTestApp() {
    return createAppWithRoutes({ signal: context.signal, routes: TEST_ROUTES });
  }

  it("serves a migrated route's declared path and both branded paths", async () => {
    const app = createTestApp();

    const legacy = await app.request(
      `${REQUEST_ORIGIN}/api/zero/slack/oauth/install`,
    );
    const canonical = await app.request(
      `${REQUEST_ORIGIN}/api/okou/slack/oauth/install`,
    );
    const declared = await app.request(
      `${REQUEST_ORIGIN}/api/slack/oauth/install`,
    );

    expect([legacy.status, canonical.status, declared.status]).toStrictEqual([
      200, 200, 200,
    ]);
    await expect(legacy.json()).resolves.toStrictEqual({ served: true });
  });

  // Before #28701 this path was served by the blanket expansion and reported
  // once per app instance. #28701 narrowed it to a table of six, and #30667
  // deleted that table: a derived legacy form is now always a 404.
  it("returns 404 for a derived legacy path while its canonical path is served", async () => {
    const app = createTestApp();

    const legacy = await app.request(
      `${REQUEST_ORIGIN}/api/zero/__test/namespace-alias`,
    );
    const canonical = await app.request(
      `${REQUEST_ORIGIN}/api/okou/__test/namespace-alias`,
    );

    expect(legacy.status).toBe(404);
    await expect(legacy.json()).resolves.toStrictEqual({ error: "Not found" });
    expect(canonical.status).toBe(200);
    await expect(canonical.json()).resolves.toStrictEqual({ served: true });
  });

  it("returns 404 for a derived legacy path template with parameters", async () => {
    const app = createTestApp();

    const legacy = await app.request(
      `${REQUEST_ORIGIN}/api/zero/__test/namespace-alias/first`,
    );
    const canonical = await app.request(
      `${REQUEST_ORIGIN}/api/okou/__test/namespace-alias/first`,
    );

    expect([legacy.status, canonical.status]).toStrictEqual([404, 200]);
  });
});
