import { randomUUID } from "node:crypto";

import { cronConnectorOauthStateCleanupContract } from "@vm0/api-contracts/contracts/cron";
import {
  zeroConnectorOauthContinueContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const CRON_SECRET = "test-connector-oauth-state-cleanup-secret";
const API_ORIGIN = "https://api.vm0.ai";

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function mockAuthenticatedSession(): void {
  mocks.clerk.session(
    `user_connector_oauth_cleanup_${randomUUID()}`,
    `org_connector_oauth_cleanup_${randomUUID()}`,
  );
}

async function startGithubOauth(): Promise<URL> {
  mockAuthenticatedSession();
  const response = await accept(
    setupApp({ context })(zeroConnectorOauthStartContract).start({
      params: { type: "github" },
      headers: { authorization: "Bearer clerk-session" },
      body: { authMethod: "oauth" },
    }),
    [200],
  );
  return new URL(response.body.authorizationUrl);
}

describe("connector OAuth state cleanup cron", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
    mockEnv("VM0_API_BACKEND_URL", API_ORIGIN);
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  });

  afterEach(() => {
    clearMockNow();
  });

  it("requires the cron secret", async () => {
    const response = await accept(
      setupApp({ context })(cronConnectorOauthStateCleanupContract).cleanup({
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid cron secret" },
    });
  });

  it("deletes expired states while preserving usable handoffs", async () => {
    mockNow(now() - 20 * 60 * 1000);
    await startGithubOauth();
    clearMockNow();
    const usableContinuationUrl = await startGithubOauth();

    const cleanup = await accept(
      setupApp({ context })(cronConnectorOauthStateCleanupContract).cleanup({
        headers: cronHeaders(),
      }),
      [200],
    );

    expect(cleanup.body.deleted).toBeGreaterThanOrEqual(1);
    const continuation = await accept(
      setupApp({ context })(zeroConnectorOauthContinueContract).continue({
        params: { type: "github" },
        query: {
          state: usableContinuationUrl.searchParams.get("state") ?? "",
        },
      }),
      [307],
    );
    expect(continuation.headers.get("location")).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/u,
    );
  });
});
