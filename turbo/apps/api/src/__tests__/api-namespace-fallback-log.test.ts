import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createAppWithRoutes } from "../app-factory-core";
import type { RouteEntry } from "../signals/route-entry";
import { testContext } from "./test-context";

const c = initContract();
const REQUEST_ORIGIN = "http://api.test";
const NAMESPACE_ALIAS_FALLBACK_TYPE = "api_namespace_alias_fallback";

// `/api/okou/realtime/token` is listed in the compatibility table in
// `route-entry.ts`. The `__test` paths deliberately are not, so they stand in
// for a legacy caller the three-day request log never saw.
const namespaceFallbackContract = c.router({
  listed: {
    method: "GET",
    path: "/api/okou/realtime/token",
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  unlisted: {
    method: "GET",
    path: "/api/okou/__test/namespace-fallback",
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  // A second method on the same path. The table is keyed by path, so both
  // registrations must collapse into a single report.
  unlistedPost: {
    method: "POST",
    path: "/api/okou/__test/namespace-fallback",
    body: z.object({}),
    responses: {
      200: z.object({ served: z.literal(true) }),
    },
  },
  unlistedById: {
    method: "GET",
    path: "/api/okou/__test/namespace-fallback/:id",
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
  { route: namespaceFallbackContract.listed, handler: served$ },
  { route: namespaceFallbackContract.unlisted, handler: served$ },
  { route: namespaceFallbackContract.unlistedPost, handler: served$ },
  { route: namespaceFallbackContract.unlistedById, handler: served$ },
];

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

describe("unlisted legacy API namespace fallback", () => {
  const context = testContext();

  function createTestApp() {
    return createAppWithRoutes({ signal: context.signal, routes: TEST_ROUTES });
  }

  function fallbackReports(): readonly string[] {
    const reports: string[] = [];
    for (const [, fields] of context.mocks.axiomLogging.warn.mock.calls) {
      if (!isRecord(fields) || fields.type !== NAMESPACE_ALIAS_FALLBACK_TYPE) {
        continue;
      }
      reports.push(String(fields.route));
    }
    return reports;
  }

  it("serves an unlisted legacy path and reports it once, not once per request", async () => {
    const app = createTestApp();
    const path = `${REQUEST_ORIGIN}/api/zero/__test/namespace-fallback`;

    const first = await app.request(path);
    const second = await app.request(path);

    expect([first.status, second.status]).toStrictEqual([200, 200]);
    await expect(second.json()).resolves.toStrictEqual({ served: true });
    expect(fallbackReports()).toStrictEqual([
      "/api/zero/__test/namespace-fallback",
    ]);
  });

  it("reports an unlisted legacy path once across all of its methods", async () => {
    const app = createTestApp();
    const path = `${REQUEST_ORIGIN}/api/zero/__test/namespace-fallback`;

    const read = await app.request(path);
    const write = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect([read.status, write.status]).toStrictEqual([200, 200]);
    expect(fallbackReports()).toStrictEqual([
      "/api/zero/__test/namespace-fallback",
    ]);
  });

  it("reports each unlisted legacy path template separately", async () => {
    const app = createTestApp();

    await app.request(`${REQUEST_ORIGIN}/api/zero/__test/namespace-fallback`);
    await app.request(
      `${REQUEST_ORIGIN}/api/zero/__test/namespace-fallback/first`,
    );
    await app.request(
      `${REQUEST_ORIGIN}/api/zero/__test/namespace-fallback/second`,
    );

    expect(fallbackReports()).toStrictEqual([
      "/api/zero/__test/namespace-fallback",
      "/api/zero/__test/namespace-fallback/:id",
    ]);
  });

  it("stays silent for a canonical path and for a listed legacy path", async () => {
    const app = createTestApp();

    const canonical = await app.request(
      `${REQUEST_ORIGIN}/api/okou/__test/namespace-fallback`,
    );
    const listedCanonical = await app.request(
      `${REQUEST_ORIGIN}/api/okou/realtime/token`,
    );
    const listedLegacy = await app.request(
      `${REQUEST_ORIGIN}/api/zero/realtime/token`,
    );

    expect([
      canonical.status,
      listedCanonical.status,
      listedLegacy.status,
    ]).toStrictEqual([200, 200, 200]);
    expect(fallbackReports()).toStrictEqual([]);
  });

  // The report is deduplicated per app instance, and `createProductionApp`
  // builds one app per process, so a redeployed instance reports again rather
  // than hiding a caller that outlived the previous one.
  it("reports again for a new app instance", async () => {
    const path = `${REQUEST_ORIGIN}/api/zero/__test/namespace-fallback`;

    await createTestApp().request(path);
    await createTestApp().request(path);

    expect(fallbackReports()).toStrictEqual([
      "/api/zero/__test/namespace-fallback",
      "/api/zero/__test/namespace-fallback",
    ]);
  });
});
