import { cronMonitorChatEventQueueContract } from "@vm0/api-contracts/contracts/cron";
import type {
  TestCronMonitorChatEventQueueStateActionBody,
  TestCronMonitorChatEventQueueStateActionResponse,
} from "@vm0/api-contracts/contracts/test-cron-monitor-chat-event-queue-state";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { testCronMonitorChatEventQueueStateRoutes } from "../test-cron-monitor-chat-event-queue-state";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const CRON_SECRET = "test-cron-secret";
const STATE_ROUTE = "/api/test/cron-monitor-chat-event-queue-state/action";

interface MonitorFixture {
  readonly composeId: string;
}

function apiClient() {
  return setupApp({ context })(cronMonitorChatEventQueueContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

async function rawCronRequest(
  headers: Record<string, string> = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request("/api/cron/monitor-chat-event-queue", {
    method: "GET",
    headers,
  });
}

async function postState(
  body: TestCronMonitorChatEventQueueStateActionBody,
): Promise<TestCronMonitorChatEventQueueStateActionResponse> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: testCronMonitorChatEventQueueStateRoutes,
  });
  const response = await app.request(STATE_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `orphan monitor state action failed with ${response.status}`,
    );
  }
  return (await response.json()) as TestCronMonitorChatEventQueueStateActionResponse;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`orphan monitor state response missing ${key}`);
  }
  return value;
}

async function seedFixture(
  fixtureKind: Extract<
    TestCronMonitorChatEventQueueStateActionBody,
    { readonly action: "seed-fixture" }
  >["fixture_kind"],
): Promise<MonitorFixture> {
  const response = await postState({
    action: "seed-fixture",
    fixture_kind: fixtureKind,
  });
  return { composeId: stringField(response, "compose_id") };
}

async function cleanupFixture(fixture: MonitorFixture): Promise<void> {
  await postState({
    action: "delete-fixture",
    compose_id: fixture.composeId,
  });
}

const trackFixture = createFixtureTracker(cleanupFixture);

describe("cron monitor chat event queue", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("requires the cron secret", async () => {
    const response = await accept(apiClient().monitor({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("reports zero for legitimate unassociated user messages", async () => {
    await Promise.all([
      trackFixture(seedFixture("active-run")),
      trackFixture(seedFixture("failed-message")),
      trackFixture(seedFixture("legacy-queued-integration")),
      trackFixture(seedFixture("queued-integration")),
      trackFixture(seedFixture("queued-message")),
      trackFixture(seedFixture("revoked-message")),
    ]);

    const response = await accept(
      apiClient().monitor({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      success: true,
      orphanedMessages: 0,
    });
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();
  });

  it("raises the existing error alert for a malformed pending event", async () => {
    await trackFixture(seedFixture("orphan"));

    const response = await rawCronRequest(cronHeaders());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
    expect(
      context.mocks.sentry.captureException.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      name: "OrphanedQueuedChatEventsError",
      code: "ORPHANED_QUEUED_CHAT_MESSAGES",
      orphanedMessages: 1,
    });
    const [, fields] = context.mocks.axiomLogging.error.mock.calls.at(-1) ?? [];
    expect(fields).toMatchObject({
      type: "unhandled_request_error",
      route: "/api/cron/monitor-chat-event-queue",
      method: "GET",
      errorCode: "ORPHANED_QUEUED_CHAT_MESSAGES",
      error: {
        name: "OrphanedQueuedChatEventsError",
        code: "ORPHANED_QUEUED_CHAT_MESSAGES",
        orphanedMessages: 1,
      },
    });
  });
});
