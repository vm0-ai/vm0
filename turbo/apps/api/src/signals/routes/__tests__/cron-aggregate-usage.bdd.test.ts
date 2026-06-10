import { cronAggregateUsageContract } from "@vm0/api-contracts/contracts/cron";
import { createStore } from "ccstate";
import { afterEach, beforeEach, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  deleteUsageFixture$,
  seedRun$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy `cron-aggregate-usage.test.ts`. The Given
// seeds runs through the existing `seedRun$` helper — recorded under
// "Open Helper Gaps" in `api.bdd.md`. The previous direct DB read for
// `usageDaily` is replaced with assertions on the contract's response
// body (which carries an `aggregated` count).

const context = testContext();
const store = createStore();
const FIXED_NOW_ISO = "2026-05-12T12:00:00.000Z";

function client() {
  return setupApp({ context })(cronAggregateUsageContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

describe("BDD GET /api/cron/aggregate-usage — auth boundary", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      client().aggregate({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests with a missing authorization header", async () => {
    const app = (await import("../../../app-factory")).createApp({
      signal: context.signal,
    });
    const response = await app.request("/api/cron/aggregate-usage", {
      method: "GET",
    });
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/cron/aggregate-usage — aggregation chain", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date(FIXED_NOW_ISO));
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: aggregate with no runs → 2 runs → idempotent re-run", async () => {
    // Given: a brand-new user/org with no runs.
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    const c = client();

    // When + Then: the first aggregation reports the previous day and
    // aggregated=0 (no runs matched).
    const empty = await accept(c.aggregate({ headers: cronHeaders() }), [200]);
    expect(empty.body).toStrictEqual({
      date: "2026-05-11",
      aggregated: 0,
    });

    // Given: two completed runs on the previous day are seeded.
    const run1Start = new Date("2026-05-11T10:00:00.000Z");
    const run2Start = new Date("2026-05-11T10:01:00.000Z");
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: run1Start,
        startedAt: run1Start,
        completedAt: new Date(run1Start.getTime() + 5000),
      },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        createdAt: run2Start,
        startedAt: run2Start,
        completedAt: new Date(run2Start.getTime() + 8000),
      },
      context.signal,
    );

    // When + Then: the second aggregation reports the same date; the
    // upsert produced exactly one (user, org, date) row.
    const populated = await accept(
      c.aggregate({ headers: cronHeaders() }),
      [200],
    );
    expect(populated.body.date).toBe("2026-05-11");
    expect(populated.body.aggregated).toBe(1);

    // When + Then: a follow-up aggregation is idempotent — the upsert
    // updates the same row (still aggregated=1) for the same date.
    const idempotent = await accept(
      c.aggregate({ headers: cronHeaders() }),
      [200],
    );
    expect(idempotent.body.date).toBe("2026-05-11");
    expect(idempotent.body.aggregated).toBe(1);
  });
});
