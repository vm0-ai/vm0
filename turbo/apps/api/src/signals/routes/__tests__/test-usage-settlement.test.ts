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

  it("prices every usage event from server-side pricing", async () => {
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
    const modelProvider = `settlement-model-${randomUUID()}`;
    const connectorProvider = `settlement-test-${randomUUID()}`;
    const browserProvider = `settlement-browser-${randomUUID()}`;

    await seedUsagePricingRows([
      {
        kind: "model",
        provider: modelProvider,
        category: "tokens.input",
        unitPrice: 19,
        unitSize: 100,
      },
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
        kind: "model",
        provider: modelProvider,
        categories: ["tokens.input"],
      });
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
        provider: modelProvider,
        category: "tokens.input",
        quantity: 100,
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
        idempotencyKey: connectorIdempotencyKey,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        ...fixture,
        kind: "browser",
        provider: browserProvider,
        category: "provider_cost_usd_micros",
        quantity: 100,
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
      creditsCharged: 19,
      billingError: null,
    });
    await expect(
      store.set(readUsageEventState$, browserIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 0,
      billingError: "missing_pricing",
    });
    await expect(
      store.set(readUsageEventState$, connectorIdempotencyKey, context.signal),
    ).resolves.toStrictEqual({
      id: expect.any(String),
      status: "processed",
      creditsCharged: 10,
      billingError: null,
    });
  });
});
