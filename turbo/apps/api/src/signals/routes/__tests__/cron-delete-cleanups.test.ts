import { randomUUID } from "node:crypto";

import {
  cronConnectorOauthStateCleanupContract,
  cronTelegramCleanupContract,
} from "@vm0/api-contracts/contracts/cron";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { stubTestTimezone } from "../../../__tests__/env-stub";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  type TestCronDeleteCleanupsStateActionBody,
  type TestCronDeleteCleanupsStateResponse,
  testCronDeleteCleanupsStateContract,
  testCronDeleteCleanupsStateResponseSchema,
  testCronDeleteCleanupsStateRoutes,
} from "../test-cron-delete-cleanups-state";

const context = testContext();
const CRON_SECRET = "test-delete-cleanups-secret";
const CONNECTOR_EXPIRED_COUNT = 10_001;
const TELEGRAM_EXPIRED_COUNT = 10_001;
const CUTOFF_MS = Date.parse("1950-01-31T00:00:00.000Z");
const TELEGRAM_NOW_MS = Date.parse("1950-03-02T00:00:00.000Z");

function connectorState(marker: string, kind: string): string {
  return `${marker}:${kind}`;
}

async function requestFixture(
  body: TestCronDeleteCleanupsStateActionBody,
): Promise<TestCronDeleteCleanupsStateResponse> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronDeleteCleanupsStateRoutes,
  });
  const response = await app.request(
    testCronDeleteCleanupsStateContract.action.path,
    {
      method: testCronDeleteCleanupsStateContract.action.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(response.status).toBe(200);
  return testCronDeleteCleanupsStateResponseSchema.parse(await response.json());
}

function registerFixtureCleanup(
  action: "delete-connector" | "delete-telegram",
  marker: string,
): void {
  onTestFinished(async () => {
    await requestFixture({ action, marker });
  });
}

async function seedConnectorFixture(expiredCount: number): Promise<string> {
  const marker = `connector-cleanup-${randomUUID()}`;
  registerFixtureCleanup("delete-connector", marker);
  await requestFixture({
    action: "seed-connector",
    marker,
    cutoff: new Date(CUTOFF_MS).toISOString(),
    expiredCount,
  });
  return marker;
}

async function seedTelegramFixture(expiredCount: number): Promise<string> {
  const marker = `telegram-cleanup-${randomUUID()}`;
  registerFixtureCleanup("delete-telegram", marker);
  await requestFixture({
    action: "seed-telegram",
    marker,
    cutoff: new Date(CUTOFF_MS).toISOString(),
    expiredCount,
  });
  return marker;
}

function cronHeaders() {
  return { authorization: `Bearer ${CRON_SECRET}` };
}

async function cleanupConnectorOauthStates() {
  return await accept(
    setupApp({ context })(cronConnectorOauthStateCleanupContract).cleanup({
      headers: cronHeaders(),
    }),
    [200],
  );
}

async function cleanupTelegramMessages() {
  return await accept(
    setupApp({ context })(cronTelegramCleanupContract).cleanup({
      headers: cronHeaders(),
    }),
    [200],
  );
}

describe("complete delete cleanup crons", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  afterEach(() => {
    clearMockNow();
    stubTestTimezone("UTC");
  });

  it("caps connector cleanup at ten batches and preserves the UTC cutoff outside UTC", async () => {
    stubTestTimezone("Asia/Shanghai");
    mockNow(CUTOFF_MS);
    const marker = await seedConnectorFixture(CONNECTOR_EXPIRED_COUNT);

    const first = await cleanupConnectorOauthStates();
    expect(first.body.deleted).toBe(10_000);
    await expect(
      requestFixture({ action: "read-connector", marker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: [
        connectorState(marker, "equal"),
        connectorState(marker, "expired-10000"),
        connectorState(marker, "future"),
      ],
    });

    const second = await cleanupConnectorOauthStates();
    expect(second.body.deleted).toBe(2);
    await expect(
      requestFixture({ action: "read-connector", marker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: [connectorState(marker, "future")],
    });

    const empty = await cleanupConnectorOauthStates();
    expect(empty.body.deleted).toBe(0);
  });

  it("runs full and short telegram batches without crossing the UTC cutoff outside UTC", async () => {
    stubTestTimezone("Asia/Shanghai");
    mockNow(TELEGRAM_NOW_MS);
    const marker = await seedTelegramFixture(TELEGRAM_EXPIRED_COUNT);

    const cleanup = await cleanupTelegramMessages();
    expect(cleanup.body.deleted).toBe(TELEGRAM_EXPIRED_COUNT);
    await expect(
      requestFixture({ action: "read-telegram", marker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: ["equal", "future"],
    });

    const empty = await cleanupTelegramMessages();
    expect(empty.body.deleted).toBe(0);
  });

  it("preserves the strict telegram cutoff in UTC", async () => {
    stubTestTimezone("UTC");
    mockNow(TELEGRAM_NOW_MS);
    const marker = await seedTelegramFixture(1);

    const cleanup = await cleanupTelegramMessages();
    expect(cleanup.body.deleted).toBe(1);
    await expect(
      requestFixture({ action: "read-telegram", marker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: ["equal", "future"],
    });
  });
});
