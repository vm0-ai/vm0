import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { testUsageSettlementContract } from "@vm0/api-contracts/contracts/test-usage-settlement";
import { onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import {
  deleteUsagePricingRows,
  seedUsagePricingRows,
} from "../../../test-fixtures/system-config-seeds";
import { testUsageSettlementRoutes } from "../test-usage-settlement";
import {
  deleteUsageInsightFixture$,
  insertUsageEvent$,
  readUsageEventState$,
  seedCompose$,
  seedRun$,
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

  it("settles usage that arrives after an earlier run settlement", async () => {
    const fixture = await store.set(
      seedUsageInsightFixture$,
      undefined,
      context.signal,
    );
    onTestFinished(async () => {
      await store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });
    const compose = await store.set(seedCompose$, fixture, context.signal);
    const { runId } = await store.set(
      seedRun$,
      { ...fixture, composeId: compose.composeId },
      context.signal,
    );
    const app = createAppWithRoutes({
      signal: context.signal,
      routes: testUsageSettlementRoutes,
    });
    const requestSettlement = () => {
      return app.request(testUsageSettlementContract.process.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId }),
      });
    };

    expect((await requestSettlement()).status).toBe(200);

    const idempotencyKey = randomUUID();
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        runId,
        kind: "model",
        provider: "historical-model",
        category: "tokens.input",
        quantity: 100,
        grossCredits: 7,
        idempotencyKey,
      },
      context.signal,
    );

    const response = await requestSettlement();

    expect(response.status).toBe(200);
    await expect(
      store.set(readUsageEventState$, idempotencyKey, context.signal),
    ).resolves.toMatchObject({
      status: "processed",
      grossCredits: 7,
      creditsCharged: 7,
    });
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
    const connectorIdempotencyKey = randomUUID();
    const connectorProvider = `settlement-test-${randomUUID()}`;

    await seedUsagePricingRows([
      {
        kind: "connector",
        provider: connectorProvider,
        category: "request",
        unitPrice: 5,
        unitSize: 1,
      },
    ]);
    onTestFinished(async () => {
      await deleteUsagePricingRows({
        kind: "connector",
        provider: connectorProvider,
        categories: ["request"],
      });
    });

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
        kind: "connector",
        provider: connectorProvider,
        category: "request",
        quantity: 2,
        grossCredits: 97,
        idempotencyKey: connectorIdempotencyKey,
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
    await expect(
      store.set(readUsageEventState$, connectorIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      grossCredits: 97,
      creditsCharged: 10,
      billingError: null,
    });
  });
});
