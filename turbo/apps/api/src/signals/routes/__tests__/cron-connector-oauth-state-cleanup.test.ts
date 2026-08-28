import { randomUUID } from "node:crypto";

import { connectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import {
  type TestCronDeleteCleanupsStateActionBody,
  type TestCronDeleteCleanupsStateResponse,
  testCronDeleteCleanupsStateContract,
  testCronDeleteCleanupsStateRoutes,
} from "../test-cron-delete-cleanups-state";
import { connectorsRoutes } from "../connectors";

const context = testContext();
const mocks = createRouteMocks(context);
const API_ORIGIN = "https://api.vm0.ai";

function mockAuthenticatedSession(marker: string): void {
  mocks.clerk.session(marker, marker);
}

async function startGithubOauth(marker: string): Promise<string> {
  mockAuthenticatedSession(marker);
  const response = await accept(
    setupApp({ context, routes: connectorsRoutes })(
      connectorOauthStartContract,
    ).start({
      params: { connectorSlug: "github" },
      headers: { authorization: "Bearer clerk-session" },
      body: { authMethod: "oauth", account: { intent: "single-account" } },
    }),
    [200],
  );
  const state = new URL(response.body.authorizationUrl).searchParams.get(
    "state",
  );
  if (!state) {
    throw new Error("GitHub OAuth authorization URL must include state");
  }
  return state;
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

function registerFixtureCleanup(marker: string): void {
  onTestFinished(async () => {
    await requestFixture({ action: "delete-connector", marker });
  });
}

describe("connector OAuth state cleanup cron", () => {
  beforeEach(() => {
    mockEnv("OKOU_API_BACKEND_URL", API_ORIGIN);
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  });

  afterEach(() => {
    clearMockNow();
  });

  it("deletes expired states while preserving unexpired states", async () => {
    const marker = `connector-oauth-cleanup-${randomUUID()}`;
    const unrelatedMarker = `connector-oauth-cleanup-${randomUUID()}`;
    registerFixtureCleanup(marker);
    registerFixtureCleanup(unrelatedMarker);

    mockNow(now() - 20 * 60 * 1000);
    const expiredState = await startGithubOauth(marker);
    const unrelatedExpiredState = await startGithubOauth(unrelatedMarker);
    clearMockNow();
    const unexpiredState = await startGithubOauth(marker);

    await expect(
      requestFixture({ action: "cleanup-connector", marker }),
    ).resolves.toStrictEqual({ ok: true, remaining: [], deleted: 1 });
    await expect(
      requestFixture({ action: "read-connector", marker }),
    ).resolves.toStrictEqual({ ok: true, remaining: [unexpiredState] });
    await expect(
      requestFixture({ action: "read-connector", marker: unrelatedMarker }),
    ).resolves.toStrictEqual({
      ok: true,
      remaining: [unrelatedExpiredState],
    });

    expect(expiredState).not.toBe(unexpiredState);
  });
});
