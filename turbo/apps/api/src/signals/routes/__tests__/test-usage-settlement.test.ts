import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
import { onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import {
  deleteUsageInsightFixture$,
  insertUsageEvent$,
  readUsageEventState$,
  seedUsageInsightFixture$,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

describe("POST /api/test/usage-settlement/process", () => {
  it("returns 404 when the test endpoint is not allowed", async () => {
    mockEnv("ENV", "production");
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: testUsageSettlementRoutes,
    });

    const response = await app.request(
      testUsageSettlementContract.process.path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: "org_test" }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("uses precomputed credits only for historical model events", async () => {
    const fixture = await store.set(
      seedUsageInsightFixture$,
      undefined,
      context.signal,
    );
    onTestFinished(async () => {
      await store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });
    const modelIdempotencyKey = randomUUID();
    const browserIdempotencyKey = randomUUID();

    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "model",
        provider: "historical-model",
        category: "tokens.input",
        quantity: 100,
        grossCredits: 19,
        idempotencyKey: modelIdempotencyKey,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "browser",
        provider: "browser-use",
        category: "provider_cost_usd_micros",
        quantity: 100,
        grossCredits: 23,
        idempotencyKey: browserIdempotencyKey,
      },
      context.signal,
    );

    const app = createAppWithRoutes({
      signal: context.signal,
      routes: testUsageSettlementRoutes,
    });
    const response = await app.request(
      testUsageSettlementContract.process.path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ org_id: fixture.orgId }),
      },
    );

    expect(response.status).toBe(200);
    await expect(
      store.set(readUsageEventState$, modelIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      grossCredits: 19,
      creditsCharged: 19,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, browserIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      grossCredits: 23,
      creditsCharged: 0,
      billingError: "missing_pricing",
    });
  });
});
