import { randomUUID } from "node:crypto";

import { cronTelegramCleanupContract } from "@vm0/api-contracts/contracts/cron";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { stubTestTimezone } from "../../../__tests__/env-stub";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import {
  type TestCronDeleteCleanupsStateActionBody,
  type TestCronDeleteCleanupsStateResponse,
  testCronDeleteCleanupsStateContract,
  testCronDeleteCleanupsStateRoutes,
} from "../test-cron-delete-cleanups-state";
import { cronTelegramCleanupRoutes } from "../cron-telegram-cleanup";

const context = testContext();
const CRON_SECRET = "test-delete-cleanups-secret";
const CONNECTOR_EXPIRED_COUNT = 10_001;
const TELEGRAM_EXPIRED_COUNT = 10_001;
const CUTOFF_MS = Date.parse("1950-01-31T00:00:00.000Z");
const TELEGRAM_CUTOFF_MS = Date.parse("1950-04-20T00:00:00.000Z");
const TELEGRAM_NOW_MS = Date.parse("1950-05-20T00:00:00.000Z");

function connectorState(marker: string, kind: string): string {
  return `${marker}:${kind}`;
}

async function requestFixture(
  body: TestCronDeleteCleanupsStateActionBody,
): Promise<TestCronDeleteCleanupsStateResponse> {
  const response = await accept(
    setupApp({ context, routes: testCronDeleteCleanupsStateRoutes })(
      testCronDeleteCleanupsStateContract,
    ).action({ body }),
    [200],
  );
  return response.body;
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
    cutoff: new Date(TELEGRAM_CUTOFF_MS).toISOString(),
    expiredCount,
  });
  return marker;
}

function cronHeaders() {
  return { authorization: `Bearer ${CRON_SECRET}` };
}

async function cleanupConnectorOauthStates(marker: string) {
  return await requestFixture({ action: "cleanup-connector", marker });
}

async function cleanupTelegramMessages() {
  return await accept(
    setupApp({ context, routes: cronTelegramCleanupRoutes })(
      cronTelegramCleanupContract,
    ).cleanup({
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
    const unrelatedMarker = await seedConnectorFixture(1);

    const first = await cleanupConnectorOauthStates(marker);
    expect(first.deleted).toBe(10_000);
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
    await expect(
      requestFixture({ action: "read-connector", marker: unrelatedMarker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: [
        connectorState(unrelatedMarker, "equal"),
        connectorState(unrelatedMarker, "expired-0"),
        connectorState(unrelatedMarker, "future"),
      ],
    });

    const second = await cleanupConnectorOauthStates(marker);
    expect(second.deleted).toBe(2);
    await expect(
      requestFixture({ action: "read-connector", marker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: [connectorState(marker, "future")],
    });

    const empty = await cleanupConnectorOauthStates(marker);
    expect(empty.deleted).toBe(0);
  }, 15_000);

  it("runs full and short telegram batches across a non-UTC daylight-saving boundary", async () => {
    stubTestTimezone("America/New_York");
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
