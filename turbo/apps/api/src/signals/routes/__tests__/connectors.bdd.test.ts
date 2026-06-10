/**
 * helper gap:
 * - Expired OAuth states, stale/hidden legacy connector rows, stale OAuth scope
 *   rows, duplicate custom connector storage conflicts, sandbox/CLI token
 *   capability cases, and simultaneous callback races do not have a stable
 *   public API constructor/assertion path. They are intentionally not rebuilt
 *   with direct database fixtures here.
 * - Feature switch overrides are configured only through
 *   /api/zero/feature-switches.
 */

import { randomUUID } from "node:crypto";

import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockBase44OAuthProvider,
  mockDeferredTestOAuthTokenEndpoint,
  mockGitHubConnectorOAuth,
  mockSlockOAuthProvider,
  mockStripeCliDashboardProvider,
  mockTestOAuthDeviceConnectorProvider,
  STRIPE_CLI_BROWSER_URL,
  STRIPE_CLI_TEST_SECRET,
} from "./helpers/api-bdd-connectors";

const context = testContext();
const connectorsApi = createConnectorBddApi(context);

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function customConnectorBody(slug: string) {
  return {
    slug,
    displayName: "BDD Custom Connector",
    prefixes: [`https://${slug}.example.test/v1/`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

function connectorByType(
  connectors: readonly ConnectorResponse[],
  type: ConnectorResponse["type"],
): ConnectorResponse | undefined {
  return connectors.find((connector) => {
    return connector.type === type;
  });
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

function expectNoVisibleSecret(value: unknown, secret: string): void {
  expect(JSON.stringify(value)).not.toContain(secret);
}

describe("CONN-01 and CHAIN-CONNECTOR: connector discovery and manual grant lifecycle", () => {
  it("discovers, connects, reads, computes scope diff, and deletes a manual connector through APIs", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const noOrgActor = bdd.user({ orgId: null });

    const unauthenticated = await connectorsApi.requestListConnectors(
      null,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const missingOrg = await connectorsApi.requestListConnectors(
      noOrgActor,
      [401],
    );
    expectApiError(missingOrg.body);
    expect(missingOrg.body.error.code).toBe("UNAUTHORIZED");

    const initialList = await connectorsApi.listConnectors(actor);
    expect(initialList.connectors).toStrictEqual([]);
    expect(initialList.configuredTypes).toContain("openai");
    expect(initialList.connectorProvidedBindings).toStrictEqual([]);

    const search = await connectorsApi.searchConnectors(actor, "OPENAI");
    const openaiSearch = search.connectors.find((connector) => {
      return connector.id === "openai";
    });
    expect(openaiSearch?.authMethods).toStrictEqual(["api-token"]);

    const missingOpenAi = await connectorsApi.requestReadConnectorByType(
      actor,
      "openai",
      [404],
    );
    expectApiError(missingOpenAi.body);
    expect(missingOpenAi.body.error.code).toBe("NOT_FOUND");

    const badGrant = await connectorsApi.requestManualGrant(
      actor,
      "openai",
      "api-token",
      {
        OPENAI_TOKEN: "sk-bdd-manual-secret",
        EXTRA_TOKEN: "secret-value-should-not-echo",
      },
      [400],
    );
    expectApiError(badGrant.body);
    expect(badGrant.body.error.message).toContain("EXTRA_TOKEN");
    expectNoVisibleSecret(badGrant.body, "secret-value-should-not-echo");

    const connected = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { OPENAI_TOKEN: " sk-bdd-manual-secret\n" },
    );
    expect(typeof connected.id).toBe("string");
    expectNoVisibleSecret(connected, "sk-bdd-manual-secret");

    const readBack = await connectorsApi.readConnectorByType(actor, "openai");
    expect(readBack).toMatchObject({
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
      oauthScopes: null,
    });
    expect(readBack.id).toBe(connected.id);
    expectNoVisibleSecret(readBack, "sk-bdd-manual-secret");

    const listAfterConnect = await connectorsApi.listConnectors(actor);
    expect(connectorByType(listAfterConnect.connectors, "openai")?.id).toBe(
      connected.id,
    );
    expect(listAfterConnect.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "openai",
        authMethod: "api-token",
        namespace: "secrets",
        name: "OPENAI_TOKEN",
      }),
    );

    await expect(
      connectorsApi.readScopeDiff(actor, "openai"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await connectorsApi.deleteConnectorByType(actor, "openai");

    const deleted = await connectorsApi.requestReadConnectorByType(
      actor,
      "openai",
      [404],
    );
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CONN-02: OAuth start and callback", () => {
  it("starts GitHub OAuth, completes the callback, rejects replay visibly, and keeps safe connector state", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "github-client-id",
    );
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });

    const connected = await connectorsApi.readConnectorByType(actor, "github");
    expect(connected).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: "42",
      externalUsername: "bdd-github-user",
      externalEmail: "bdd-github@example.test",
      oauthScopes: ["repo", "project", "workflow"],
      connectionStatus: "connected",
    });
    expectNoVisibleSecret(connected, "github-access-github-success-code");

    await expect(
      connectorsApi.readScopeDiff(actor, "github"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: ["repo", "project", "workflow"],
      storedScopes: ["repo", "project", "workflow"],
    });

    await connectorsApi.completeOauthCallback("github", {
      code: "github-replay-code",
      state,
    });
    const afterReplay = await connectorsApi.readConnectorByType(
      actor,
      "github",
    );
    expect(afterReplay.id).toBe(connected.id);
    expect(afterReplay.externalUsername).toBe("bdd-github-user");

    const failedActor = bdd.user();
    const failedStart = await connectorsApi.startOauth(
      failedActor,
      "github",
      "oauth",
    );
    const failedState = stateFromAuthorizationUrl(failedStart.authorizationUrl);
    await connectorsApi.completeOauthCallback("github", {
      error: "access_denied",
      error_description: "Provider denied access",
      state: failedState,
    });
    const failedConnector = await connectorsApi.requestReadConnectorByType(
      failedActor,
      "github",
      [404],
    );
    expectApiError(failedConnector.body);
    expect(failedConnector.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects OAuth start requests that target unsupported or unavailable auth methods", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const unauthenticated = await connectorsApi.requestOauthStart(
      null,
      "github",
      "oauth",
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const wrongGrant = await connectorsApi.requestOauthStart(
      actor,
      "openai",
      "api-token",
      [400],
    );
    expectApiError(wrongGrant.body);
    expect(wrongGrant.body.error.message).toContain(
      "openai connector does not use an auth-code grant",
    );

    const missingMethod = await connectorsApi.requestOauthStart(
      actor,
      "github",
      "api-token",
      [400],
    );
    expectApiError(missingMethod.body);
    expect(missingMethod.body.error.message).toContain(
      "github connector does not have api-token auth method",
    );
  });
});

describe("CONN-02: OAuth device authorization", () => {
  it("starts and completes a device authorization session, with state visible through connector APIs", async () => {
    mockTestOAuthDeviceConnectorProvider();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const visible = await connectorsApi.searchConnectors(
      actor,
      "test oauth device",
    );
    expect(
      visible.connectors.find((connector) => {
        return connector.id === "test-oauth-device";
      })?.authMethods,
    ).toStrictEqual(["oauth", "api"]);

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    expect(session).toMatchObject({
      type: "test-oauth-device",
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
    });

    const otherActor = bdd.user({ orgId: actor.orgId });
    const crossUserPoll = await connectorsApi.requestDeviceAuthPoll(
      otherActor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [404],
    );
    expectApiError(crossUserPoll.body);
    expect(crossUserPoll.body.error.code).toBe("NOT_FOUND");

    const poll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
    );
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") {
      throw new Error(`Expected complete device auth, received ${poll.status}`);
    }
    expect(poll.connector).toMatchObject({
      type: "test-oauth-device",
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: ["read"],
    });

    const readBack = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(poll.connector.id);

    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorByType(listed.connectors, "test-oauth-device")?.id).toBe(
      poll.connector.id,
    );

    await connectorsApi.deleteConnectorByType(actor, "test-oauth-device");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("rejects device-auth starts through visible validation, grant, and availability boundaries", async () => {
    const testOauthProvider = mockTestOAuthDeviceConnectorProvider();
    const stripeProvider = mockStripeCliDashboardProvider();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    const switchlessActor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const unauthenticated = await connectorsApi.requestDeviceAuthStart(
      null,
      "test-oauth-device",
      "oauth",
      undefined,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const authCodeOnly = await connectorsApi.requestDeviceAuthStart(
      actor,
      "github",
      "oauth",
      undefined,
      [400],
    );
    expectApiError(authCodeOnly.body);
    expect(authCodeOnly.body.error.message).toBe(
      "github connector does not support a device-auth grant",
    );

    const noGrant = await connectorsApi.requestDeviceAuthStart(
      actor,
      "cloudinary",
      "oauth",
      undefined,
      [400],
    );
    expectApiError(noGrant.body);
    expect(noGrant.body.error.message).toBe(
      "cloudinary connector does not use an auth-code or device-auth grant",
    );

    const missingMethod = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api-token",
      undefined,
      [400],
    );
    expectApiError(missingMethod.body);
    expect(missingMethod.body.error.message).toBe(
      "test-oauth-device connector does not have api-token auth method",
    );

    const optionsUnsupported = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "oauth",
      { mode: "live" },
      [400],
    );
    expectApiError(optionsUnsupported.body);
    expect(optionsUnsupported.body.error.message).toBe(
      "test-oauth-device oauth device-auth start options are not supported: mode",
    );

    const invalidOptionValue = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      { mode: "production" },
      [400],
    );
    expectApiError(invalidOptionValue.body);
    expect(invalidOptionValue.body.error.message).toBe(
      "test-oauth-device api device-auth start option mode must be one of: test, live",
    );

    const unexpectedOptionKey = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      { region: "us" },
      [400],
    );
    expectApiError(unexpectedOptionKey.body);
    expect(unexpectedOptionKey.body.error.message).toBe(
      "test-oauth-device api device-auth start option region is not supported",
    );

    const prototypeOptionKey = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      Object.fromEntries([["toString", "live"]]),
      [400],
    );
    expectApiError(prototypeOptionKey.body);
    expect(prototypeOptionKey.body.error.message).toBe(
      "test-oauth-device api device-auth start option toString is not supported",
    );

    const invalidStripeMode = await connectorsApi.requestDeviceAuthStart(
      actor,
      "stripe",
      "cli",
      { mode: "production" },
      [400],
    );
    expectApiError(invalidStripeMode.body);
    expect(invalidStripeMode.body.error.message).toBe(
      "stripe cli device-auth start option mode must be one of: test, live",
    );

    const disabled = await connectorsApi.requestDeviceAuthStart(
      switchlessActor,
      "test-oauth-device",
      "oauth",
      undefined,
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.message).toBe(
      "OAuth device authorization is not enabled for this connector",
    );

    expect(testOauthProvider.deviceCodeBodies).toStrictEqual([]);
    expect(stripeProvider.startBodies).toStrictEqual([]);

    const missingSession = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      randomUUID(),
      "wrong-session-token",
      [404],
    );
    expectApiError(missingSession.body);
    expect(missingSession.body.error.message).toBe(
      "OAuth device authorization session not found",
    );

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("supersedes, completes, and idempotently re-reads device authorization sessions per auth method", async () => {
    const provider = mockTestOAuthDeviceConnectorProvider({
      tokenScope: "read granted",
    });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    await connectorsApi.startDeviceAuth(actor, "test-oauth-device", "api", {
      mode: "live",
    });
    expect(provider.deviceCodeBodies[0]?.get("client_id")).toBe(
      "test-oauth-device-api-client",
    );
    expect(provider.deviceCodeBodies[0]?.get("mode")).toBe("live");

    const apiSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "api",
    );
    expect(provider.deviceCodeBodies[1]?.get("mode")).toBe("test");

    const first = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    expect(first).toMatchObject({
      type: "test-oauth-device",
      status: "pending",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      verificationUriComplete:
        "https://oauth-device.test/device?user_code=TEST-DEVICE",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(first)).not.toContain("test-device:");

    const second = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );

    const superseded = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      first.sessionId,
      first.sessionToken,
    );
    expect(superseded).toStrictEqual({
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });

    const apiPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      apiSession.sessionId,
      apiSession.sessionToken,
    );
    expect(apiPoll.status).toBe("complete");
    if (apiPoll.status !== "complete") {
      throw new Error(
        `Expected complete api-method device auth, received ${apiPoll.status}`,
      );
    }
    expect(apiPoll.connector.authMethod).toBe("api");
    const apiTokenBody = provider.tokenBodies.find((body) => {
      return body.get("device_code")?.endsWith(":read:test");
    });
    expect(apiTokenBody?.get("device_code")).toBe(
      "test-device:test-oauth-device-api-client:read:test",
    );

    await connectorsApi.deleteConnectorByType(actor, "test-oauth-device");

    const completed = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      second.sessionId,
      second.sessionToken,
    );
    expect(completed.status).toBe("complete");
    if (completed.status !== "complete") {
      throw new Error(
        `Expected complete oauth device auth, received ${completed.status}`,
      );
    }
    expect(completed.connector).toMatchObject({
      type: "test-oauth-device",
      authMethod: "oauth",
      connectionStatus: "connected",
      oauthScopes: ["read", "granted"],
    });
    expect(JSON.stringify(completed)).not.toContain("test-device-access");

    const readBack = await connectorsApi.readConnectorByType(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(completed.connector.id);
    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorByType(listed.connectors, "test-oauth-device")?.id).toBe(
      completed.connector.id,
    );

    const tokenCallsBeforeRePoll = provider.tokenBodies.length;
    const rePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      second.sessionId,
      second.sessionToken,
    );
    expect(rePoll.status).toBe("complete");
    if (rePoll.status !== "complete") {
      throw new Error(
        `Expected idempotent complete device auth, received ${rePoll.status}`,
      );
    }
    expect(rePoll.connector.id).toBe(completed.connector.id);
    expect(provider.tokenBodies).toHaveLength(tokenCallsBeforeRePoll);

    await connectorsApi.deleteConnectorByType(actor, "test-oauth-device");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("walks pending, slow-down, interval, terminal, and expiry poll states through the API", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const intervalProvider = mockTestOAuthDeviceConnectorProvider({
      interval: 5,
    });
    const gated = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const gatedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      gated.sessionId,
      gated.sessionToken,
    );
    expect(gatedPoll).toStrictEqual({ status: "pending", interval: 5 });
    expect(intervalProvider.tokenBodies).toHaveLength(0);

    const pendingProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "pending",
    });
    const pending = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const pendingPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      pending.sessionId,
      pending.sessionToken,
    );
    expect(pendingPoll).toStrictEqual({ status: "pending", interval: 0 });
    const pendingRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      pending.sessionId,
      pending.sessionToken,
    );
    expect(pendingRePoll).toStrictEqual({ status: "pending", interval: 0 });
    expect(pendingProvider.tokenBodies).toHaveLength(2);

    const slowDownProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "slow-down",
    });
    const slowDown = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const slowDownPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      slowDown.sessionId,
      slowDown.sessionToken,
    );
    expect(slowDownPoll).toStrictEqual({ status: "pending", interval: 5 });
    const slowDownRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      slowDown.sessionId,
      slowDown.sessionToken,
    );
    expect(slowDownRePoll).toStrictEqual({ status: "pending", interval: 5 });
    expect(slowDownProvider.tokenBodies).toHaveLength(1);

    const terminalCases = [
      {
        deviceCode: "denied",
        expected: {
          status: "denied",
          errorCode: "access_denied",
          errorMessage: "User denied the device authorization request",
        },
      },
      {
        deviceCode: "expired",
        expected: {
          status: "expired",
          errorCode: "expired_token",
          errorMessage: "Device authorization expired",
        },
      },
      {
        deviceCode: "error",
        expected: {
          status: "error",
          errorCode: "invalid_request",
          errorMessage: "Synthetic device authorization error",
        },
      },
      {
        deviceCode: "not-issued",
        expected: {
          status: "error",
          errorCode: "invalid_grant",
          errorMessage: "Unknown device authorization code",
        },
      },
    ] as const;

    for (const terminalCase of terminalCases) {
      const terminalProvider = mockTestOAuthDeviceConnectorProvider({
        deviceCode: terminalCase.deviceCode,
      });
      const session = await connectorsApi.startDeviceAuth(
        actor,
        "test-oauth-device",
        "oauth",
      );
      const poll = await connectorsApi.pollDeviceAuth(
        actor,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      expect(poll).toStrictEqual(terminalCase.expected);
      const rePoll = await connectorsApi.pollDeviceAuth(
        actor,
        "test-oauth-device",
        session.sessionId,
        session.sessionToken,
      );
      expect(rePoll).toStrictEqual(terminalCase.expected);
      expect(terminalProvider.tokenBodies).toHaveLength(1);
    }

    mockTestOAuthDeviceConnectorProvider({ expiresIn: 0 });
    const expiring = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    mockNow(now() + 2000);
    const expiredPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      expiring.sessionId,
      expiring.sessionToken,
    );
    expect(expiredPoll).toStrictEqual({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
    });
    const expiredRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      expiring.sessionId,
      expiring.sessionToken,
    );
    expect(expiredRePoll).toStrictEqual({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
    });
    clearMockNow();

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("serializes concurrent polls and restores claims after races and provider failures", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthDeviceConnectorProvider();
    const deferred = mockDeferredTestOAuthTokenEndpoint();

    const first = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const racedPollPromise = connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      first.sessionId,
      first.sessionToken,
    );
    await deferred.started;

    const concurrentPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      first.sessionId,
      first.sessionToken,
    );
    expect(concurrentPoll).toStrictEqual({ status: "pending", interval: 0 });
    expect(deferred.calls()).toBe(1);

    await connectorsApi.startDeviceAuth(actor, "test-oauth-device", "oauth");
    deferred.release();
    const racedPoll = await racedPollPromise;
    expect(racedPoll).toStrictEqual({
      status: "error",
      errorCode: "session_superseded",
      errorMessage: "OAuth device authorization session was superseded",
    });
    expect(deferred.calls()).toBe(1);

    const nothingPersisted = await connectorsApi.requestReadConnectorByType(
      actor,
      "test-oauth-device",
      [404],
    );
    expectApiError(nothingPersisted.body);
    expect(nothingPersisted.body.error.code).toBe("NOT_FOUND");

    mockTestOAuthDeviceConnectorProvider({
      deviceCode: "pending",
      tokenBehavior: "emptyJson",
    });
    const failing = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const providerFailure = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      failing.sessionId,
      failing.sessionToken,
      [500],
    );
    expect(providerFailure.body).toStrictEqual({
      error: "Internal server error",
    });

    const restoredProvider = mockTestOAuthDeviceConnectorProvider({
      deviceCode: "pending",
    });
    const restoredPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      failing.sessionId,
      failing.sessionToken,
    );
    expect(restoredPoll).toStrictEqual({ status: "pending", interval: 0 });
    expect(restoredProvider.tokenBodies).toHaveLength(1);

    const staleDeferred = mockDeferredTestOAuthTokenEndpoint();
    const stale = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const stalePollPromise = connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      stale.sessionId,
      stale.sessionToken,
    );
    await staleDeferred.started;
    mockNow(now() + 31_000);

    const reclaimedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      stale.sessionId,
      stale.sessionToken,
    );
    expect(reclaimedPoll).toStrictEqual({ status: "pending", interval: 0 });
    expect(staleDeferred.calls()).toBe(2);
    staleDeferred.release();
    const stalePoll = await stalePollPromise;
    expect(stalePoll).toStrictEqual({ status: "pending", interval: 0 });
    clearMockNow();

    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("runs the Stripe CLI dashboard device flow with redacted provider state", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();

    const startProvider = mockStripeCliDashboardProvider();
    const started = await connectorsApi.startDeviceAuth(
      actor,
      "stripe",
      "cli",
      {
        mode: "test",
      },
    );
    expect(started).toMatchObject({
      type: "stripe",
      status: "pending",
      userCode: "STRIPE-CLI",
      verificationUri: STRIPE_CLI_BROWSER_URL,
      verificationUriComplete: STRIPE_CLI_BROWSER_URL,
      expiresIn: 600,
      interval: 1,
    });
    expect(JSON.stringify(started)).not.toContain("poll_token");
    expect(startProvider.startBodies).toHaveLength(1);
    expect(startProvider.startBodies[0]?.get("device_name")).toBe(
      "vm0-stripe-connector",
    );
    expect(startProvider.startBodies[0]?.get("client_version")).toBeTruthy();

    mockStripeCliDashboardProvider({ pollToken: "pending" });
    const pendingSession = await connectorsApi.startDeviceAuth(
      actor,
      "stripe",
      "cli",
      { mode: "test" },
    );
    mockNow(now() + 2000);
    const pendingPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "stripe",
      pendingSession.sessionId,
      pendingSession.sessionToken,
    );
    expect(pendingPoll).toStrictEqual({ status: "pending", interval: 1 });
    clearMockNow();

    const completeProvider = mockStripeCliDashboardProvider({
      pollToken: "test-complete",
    });
    const completing = await connectorsApi.startDeviceAuth(
      actor,
      "stripe",
      "cli",
      { mode: "test" },
    );
    const completionBase = now();
    mockNow(completionBase + 2000);
    const completedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "stripe",
      completing.sessionId,
      completing.sessionToken,
    );
    expect(completedPoll.status).toBe("complete");
    if (completedPoll.status !== "complete") {
      throw new Error(
        `Expected complete Stripe device auth, received ${completedPoll.status}`,
      );
    }
    expect(JSON.stringify(completedPoll)).not.toContain(STRIPE_CLI_TEST_SECRET);
    expect(
      completeProvider.pollUrls.some((pollUrl) => {
        return (
          new URL(pollUrl).searchParams.get("poll_token") === "test-complete"
        );
      }),
    ).toBeTruthy();

    const stripeConnector = await connectorsApi.readConnectorByType(
      actor,
      "stripe",
    );
    expect(stripeConnector).toMatchObject({
      type: "stripe",
      authMethod: "cli",
      externalId: "acct_test",
      externalUsername: "Test Stripe Account",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected",
    });
    expect(JSON.stringify(stripeConnector)).not.toContain(
      STRIPE_CLI_TEST_SECRET,
    );
    if (!stripeConnector.tokenExpiresAt) {
      throw new Error("Expected Stripe CLI token expiry to be visible");
    }
    const tokenExpiresAtMs = Date.parse(stripeConnector.tokenExpiresAt);
    expect(tokenExpiresAtMs).toBeGreaterThan(
      completionBase + 2000 + 89 * 24 * 60 * 60 * 1000,
    );
    expect(tokenExpiresAtMs).toBeLessThanOrEqual(
      completionBase + 2000 + 90 * 24 * 60 * 60 * 1000,
    );
    clearMockNow();
    await connectorsApi.deleteConnectorByType(actor, "stripe");

    mockStripeCliDashboardProvider({ pollToken: "malformed" });
    const malformed = await connectorsApi.startDeviceAuth(
      actor,
      "stripe",
      "cli",
      { mode: "test" },
    );
    mockNow(now() + 2000);
    const malformedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "stripe",
      malformed.sessionId,
      malformed.sessionToken,
    );
    expect(malformedPoll.status).toBe("error");
    if (malformedPoll.status !== "error") {
      throw new Error(
        `Expected Stripe device auth error, received ${malformedPoll.status}`,
      );
    }
    expect(malformedPoll.errorMessage).not.toContain("secret-poll");
    expect(malformedPoll.errorMessage).not.toContain(STRIPE_CLI_TEST_SECRET);
    clearMockNow();

    mockStripeCliDashboardProvider({ oversizePollUrl: true });
    const oversize = await connectorsApi.requestDeviceAuthStart(
      actor,
      "stripe",
      "cli",
      { mode: "test" },
      [500],
    );
    expect(oversize.body).toStrictEqual({ error: "Internal server error" });
  });

  it("completes Base44 and Slock device sessions with provider metadata visible through connector reads", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();

    const base44Provider = mockBase44OAuthProvider();
    const base44Session = await connectorsApi.startDeviceAuth(
      actor,
      "base44",
      "oauth",
    );
    expect(base44Session).toMatchObject({
      type: "base44",
      status: "pending",
      userCode: "BASE-44",
      verificationUri: "https://app.base44.com/device",
      verificationUriComplete:
        "https://app.base44.com/device?user_code=BASE-44",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(base44Session)).not.toContain("base44-device-code");
    expect(base44Provider.deviceCodeBodies).toStrictEqual([
      { client_id: "base44_cli", scope: "apps:read apps:write offline" },
    ]);

    const base44Poll = await connectorsApi.pollDeviceAuth(
      actor,
      "base44",
      base44Session.sessionId,
      base44Session.sessionToken,
    );
    expect(base44Poll.status).toBe("complete");
    if (base44Poll.status !== "complete") {
      throw new Error(
        `Expected complete Base44 device auth, received ${base44Poll.status}`,
      );
    }
    expect(JSON.stringify(base44Poll)).not.toContain("base44-access-token");
    expect(JSON.stringify(base44Poll)).not.toContain("base44-refresh-token");
    expect(base44Provider.tokenBodies).toHaveLength(1);
    expect(base44Provider.tokenBodies[0]?.get("client_id")).toBe("base44_cli");
    expect(base44Provider.tokenBodies[0]?.get("device_code")).toBe(
      "base44-device-code",
    );
    expect(base44Provider.userinfoAuthorizations).toStrictEqual([
      "Bearer base44-access-token",
    ]);

    const base44Connector = await connectorsApi.readConnectorByType(
      actor,
      "base44",
    );
    expect(base44Connector).toMatchObject({
      type: "base44",
      authMethod: "oauth",
      externalId: "base44-user-id",
      externalUsername: "Base44 User",
      externalEmail: "base44@example.com",
      oauthScopes: ["apps:read", "apps:write", "offline"],
      connectionStatus: "connected",
    });
    expect(JSON.stringify(base44Connector)).not.toContain(
      "base44-access-token",
    );
    await connectorsApi.deleteConnectorByType(actor, "base44");

    const slockProvider = mockSlockOAuthProvider();
    const slockSession = await connectorsApi.startDeviceAuth(
      actor,
      "slock",
      "oauth",
    );
    expect(slockSession).toMatchObject({
      type: "slock",
      status: "pending",
      userCode: "SLOCK-1",
      verificationUri: "https://api.slock.ai/device",
      expiresIn: 600,
      interval: 0,
    });
    expect(JSON.stringify(slockSession)).not.toContain("slock-device-code");

    const slockPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "slock",
      slockSession.sessionId,
      slockSession.sessionToken,
    );
    expect(slockPoll.status).toBe("complete");
    if (slockPoll.status !== "complete") {
      throw new Error(
        `Expected complete Slock device auth, received ${slockPoll.status}`,
      );
    }
    expect(JSON.stringify(slockPoll)).not.toContain(slockProvider.accessToken);
    expect(JSON.stringify(slockPoll)).not.toContain("slock-refresh-token");

    const slockConnector = await connectorsApi.readConnectorByType(
      actor,
      "slock",
    );
    expect(slockConnector).toMatchObject({
      type: "slock",
      authMethod: "oauth",
      externalId: "slock-user-id",
      externalUsername: "Slock User",
      externalEmail: "slock@example.com",
      oauthScopes: [],
      connectionStatus: "connected",
    });
    if (!slockConnector.tokenExpiresAt) {
      throw new Error("Expected Slock token expiry to be visible");
    }
    const slockExpiryMs = Date.parse(slockConnector.tokenExpiresAt);
    expect(slockExpiryMs).toBeGreaterThan(now() + 850_000);
    expect(slockExpiryMs).toBeLessThanOrEqual(now() + 900_000);
    await connectorsApi.deleteConnectorByType(actor, "slock");

    mockSlockOAuthProvider({ deviceCode: "userinfo-error" });
    const failing = await connectorsApi.startDeviceAuth(
      actor,
      "slock",
      "oauth",
    );
    const failedPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "slock",
      failing.sessionId,
      failing.sessionToken,
    );
    expect(failedPoll).toStrictEqual({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
    const failedRePoll = await connectorsApi.pollDeviceAuth(
      actor,
      "slock",
      failing.sessionId,
      failing.sessionToken,
    );
    expect(failedRePoll).toStrictEqual({
      status: "error",
      errorCode: "post_token_lookup_failed",
      errorMessage:
        "Unable to load Slock account metadata after authorization.",
    });
  });

  it("rejects polls after the connector auth method becomes unavailable", async () => {
    mockTestOAuthDeviceConnectorProvider({ deviceCode: "pending" });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );

    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: false,
    });

    const disabledPoll = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [403],
    );
    expectApiError(disabledPoll.body);
    expect(disabledPoll.body.error.message).toBe(
      "OAuth device authorization is not enabled for this connector",
    );
  });
});

describe("CONN-02: external-code authorization", () => {
  it("rejects external-code sessions through visible auth, grant, switch, and session boundaries", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const missingSessionId = randomUUID();

    const unauthenticated = await connectorsApi.requestExternalCodeStart(
      null,
      "aws",
      "cli",
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const unsupportedGrant = await connectorsApi.requestExternalCodeStart(
      actor,
      "openai",
      "api-token",
      [400],
    );
    expectApiError(unsupportedGrant.body);
    expect(unsupportedGrant.body.error.message).toContain(
      "openai api-token auth method does not use an external-code grant",
    );

    const disabled = await connectorsApi.requestExternalCodeStart(
      actor,
      "aws",
      "cli",
      [403],
    );
    expectApiError(disabled.body);
    expect(disabled.body.error.message).toBe(
      "External-code authorization is not enabled for this connector",
    );

    const invalidCompleteBody = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: missingSessionId,
        sessionToken: "bdd-session-token",
        code: "",
      },
      [400],
    );
    expectApiError(invalidCompleteBody.body);
    expect(invalidCompleteBody.body.error.code).toBe("BAD_REQUEST");

    const missingComplete = await connectorsApi.requestExternalCodeComplete(
      actor,
      "aws",
      {
        sessionId: missingSessionId,
        sessionToken: "bdd-session-token",
        code: "bdd-code",
      },
      [404],
    );
    expectApiError(missingComplete.body);
    expect(missingComplete.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CONN-03: custom connectors and connector-owned secrets", () => {
  it("creates, patches, secrets, enables for an agent, rejects cross-org ids, and deletes through APIs", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();

    const admin = bdd.user({ orgRole: "org:admin" });
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const slug = uniqueSlug("bdd-custom");
    const secretValue = "custom-connector-secret-value";

    const memberCreate = await connectorsApi.requestCreateCustomConnector(
      member,
      customConnectorBody(uniqueSlug("member-custom")),
      [403],
    );
    expectApiError(memberCreate.body);
    expect(memberCreate.body.error.code).toBe("FORBIDDEN");

    const invalidPrefix = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        ...customConnectorBody(uniqueSlug("bad-custom")),
        prefixes: ["http://api.example.test/"],
      },
      [400],
    );
    expectApiError(invalidPrefix.body);
    expect(invalidPrefix.body.error.message).toContain("https");

    const created = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(slug),
    );
    const listAfterCreate = await connectorsApi.listCustomConnectors(admin);
    expect(
      listAfterCreate.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      slug,
      displayName: "BDD Custom Connector",
      prefixes: [`https://${slug}.example.test/v1/`],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
      hasSecret: false,
    });

    await connectorsApi.setCustomConnectorSecret(
      admin,
      created.id,
      secretValue,
    );
    const afterSecret = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterSecret.find((connector) => {
        return connector.id === created.id;
      })?.hasSecret,
    ).toBeTruthy();
    expectNoVisibleSecret(afterSecret, secretValue);

    await connectorsApi.patchCustomConnector(admin, created.id, {
      displayName: "BDD Custom Connector Renamed",
    });

    const listAfterPatch = await connectorsApi.listCustomConnectors(admin);
    expect(
      listAfterPatch.find((connector) => {
        return connector.id === created.id;
      }),
    ).toMatchObject({
      displayName: "BDD Custom Connector Renamed",
      hasSecret: true,
    });

    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Connector Agent",
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([]);

    await connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, [
      created.id,
    ]);
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([created.id]);

    const otherAdmin = bdd.user({ orgRole: "org:admin" });
    const otherConnector = await connectorsApi.createCustomConnector(
      otherAdmin,
      customConnectorBody(uniqueSlug("other-custom")),
    );
    const crossOrg = await connectorsApi.requestUpdateAgentCustomConnectors(
      admin,
      agent.agentId,
      [otherConnector.id],
      [400],
    );
    expectApiError(crossOrg.body);
    expect(crossOrg.body.error.code).toBe("VALIDATION_ERROR");

    await connectorsApi.updateAgentCustomConnectors(admin, agent.agentId, []);
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([]);

    await connectorsApi.deleteCustomConnectorSecret(admin, created.id);
    const afterSecretDelete = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterSecretDelete.find((connector) => {
        return connector.id === created.id;
      })?.hasSecret,
    ).toBeFalsy();

    await connectorsApi.deleteCustomConnector(admin, created.id);
    const afterDelete = await connectorsApi.listCustomConnectors(admin);
    expect(
      afterDelete.find((connector) => {
        return connector.id === created.id;
      }),
    ).toBeUndefined();

    await connectorsApi.deleteCustomConnector(otherAdmin, otherConnector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("rejects unauthenticated and org-less callers across all custom connector routes", async () => {
    const bdd = createBddApi(context);
    const noOrgActor = bdd.user({ orgId: null });
    const connectorId = randomUUID();

    for (const actor of [null, noOrgActor]) {
      const list = await connectorsApi.requestListCustomConnectors(
        actor,
        [401],
      );
      expectApiError(list.body);
      expect(list.body.error.code).toBe("UNAUTHORIZED");

      const create = await connectorsApi.requestCreateCustomConnector(
        actor,
        customConnectorBody(uniqueSlug("noauth-custom")),
        [401],
      );
      expectApiError(create.body);
      expect(create.body.error.code).toBe("UNAUTHORIZED");

      const patch = await connectorsApi.requestPatchCustomConnector(
        actor,
        connectorId,
        { displayName: "Renamed" },
        [401],
      );
      expectApiError(patch.body);
      expect(patch.body.error.code).toBe("UNAUTHORIZED");

      const remove = await connectorsApi.requestDeleteCustomConnector(
        actor,
        connectorId,
        [401],
      );
      expectApiError(remove.body);
      expect(remove.body.error.code).toBe("UNAUTHORIZED");

      const secretSet = await connectorsApi.requestSetCustomConnectorSecret(
        actor,
        connectorId,
        "unauthorized-secret-value",
        [401],
      );
      expectApiError(secretSet.body);
      expect(secretSet.body.error.code).toBe("UNAUTHORIZED");

      const secretDelete =
        await connectorsApi.requestDeleteCustomConnectorSecret(
          actor,
          connectorId,
          [401],
        );
      expectApiError(secretDelete.body);
      expect(secretDelete.body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("validates and normalises custom connector creation through visible create and list responses", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);
    const host = `bdd${rand}.example.test`;

    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);

    const autoSlug = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Auto Slug",
      prefixes: [`https://api.${host}/v1`],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });
    expect(autoSlug.slug).toMatch(
      new RegExp(`^api-bdd${rand}-example-test-[a-z0-9]{6}$`),
    );
    expect(autoSlug.prefixes).toStrictEqual([`https://api.${host}/v1/`]);
    expect(autoSlug.hasSecret).toBeFalsy();

    const wildcard = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Wildcard",
      prefixes: [`https://*.${host}/v1`],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });
    expect(wildcard.slug).toMatch(
      new RegExp(`^bdd${rand}-example-test-[a-z0-9]{6}$`),
    );
    expect(wildcard.prefixes).toStrictEqual([`https://*.${host}/v1/`]);

    const missingPlaceholder = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        displayName: "BDD Bad Template",
        prefixes: [`https://template.${host}/`],
        headerName: "Authorization",
        headerTemplate: "Bearer static-token",
      },
      [400],
    );
    expectApiError(missingPlaceholder.body);
    expect(missingPlaceholder.body.error.message).toContain("{{secret}}");

    const builtinCollision = await connectorsApi.requestCreateCustomConnector(
      admin,
      {
        displayName: "Fake GitHub",
        prefixes: ["https://api.github.com/v3/"],
        headerName: "Authorization",
        headerTemplate: "Bearer {{secret}}",
      },
      [400],
    );
    expectApiError(builtinCollision.body);
    expect(builtinCollision.body.error.message).toContain("api.github.com");
    expect(builtinCollision.body.error.message).toContain("GitHub");

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed
        .map((connector) => {
          return connector.id;
        })
        .sort(),
    ).toStrictEqual([autoSlug.id, wildcard.id].sort());

    await connectorsApi.deleteCustomConnector(admin, autoSlug.id);
    await connectorsApi.deleteCustomConnector(admin, wildcard.id);
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("scopes custom connector rename and delete to org admins and same-org ids", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const otherAdmin = bdd.user();

    const mine = await connectorsApi.createCustomConnector(admin, {
      ...customConnectorBody(uniqueSlug("bdd-own")),
      displayName: "Original",
    });
    const foreign = await connectorsApi.createCustomConnector(otherAdmin, {
      ...customConnectorBody(uniqueSlug("bdd-foreign")),
      displayName: "OtherOrg",
    });

    const memberPatch = await connectorsApi.requestPatchCustomConnector(
      member,
      mine.id,
      { displayName: "Hacked" },
      [403],
    );
    expectApiError(memberPatch.body);
    expect(memberPatch.body.error.message).toBe(
      "Only org admins can rename custom connectors",
    );

    const memberDelete = await connectorsApi.requestDeleteCustomConnector(
      member,
      mine.id,
      [403],
    );
    expectApiError(memberDelete.body);
    expect(memberDelete.body.error.message).toBe(
      "Only org admins can delete custom connectors",
    );

    const unknownPatch = await connectorsApi.requestPatchCustomConnector(
      admin,
      randomUUID(),
      { displayName: "Renamed" },
      [404],
    );
    expectApiError(unknownPatch.body);
    expect(unknownPatch.body.error.message).toBe("Custom connector not found");

    const crossOrgPatch = await connectorsApi.requestPatchCustomConnector(
      admin,
      foreign.id,
      { displayName: "Hijacked" },
      [404],
    );
    expectApiError(crossOrgPatch.body);
    expect(crossOrgPatch.body.error.code).toBe("NOT_FOUND");

    const emptyName = await connectorsApi.requestPatchCustomConnector(
      admin,
      mine.id,
      { displayName: "" },
      [400],
    );
    expectApiError(emptyName.body);
    expect(emptyName.body.error.code).toBe("BAD_REQUEST");

    const blankName = await connectorsApi.requestPatchCustomConnector(
      admin,
      mine.id,
      { displayName: " " },
      [400],
    );
    expectApiError(blankName.body);
    expect(blankName.body.error.message).toContain("between 1 and 128");

    const myList = await connectorsApi.listCustomConnectors(admin);
    expect(
      myList.find((connector) => {
        return connector.id === mine.id;
      })?.displayName,
    ).toBe("Original");

    const unknownDelete = await connectorsApi.requestDeleteCustomConnector(
      admin,
      randomUUID(),
      [404],
    );
    expectApiError(unknownDelete.body);
    expect(unknownDelete.body.error.code).toBe("NOT_FOUND");

    const crossOrgDelete = await connectorsApi.requestDeleteCustomConnector(
      admin,
      foreign.id,
      [404],
    );
    expectApiError(crossOrgDelete.body);
    expect(crossOrgDelete.body.error.code).toBe("NOT_FOUND");

    const otherList = await connectorsApi.listCustomConnectors(otherAdmin);
    expect(
      otherList.find((connector) => {
        return connector.id === foreign.id;
      })?.displayName,
    ).toBe("OtherOrg");

    await connectorsApi.setCustomConnectorSecret(
      otherAdmin,
      foreign.id,
      "foreign-secret-value",
    );
    await connectorsApi.deleteCustomConnector(admin, mine.id);
    await connectorsApi.deleteCustomConnector(otherAdmin, foreign.id);
    const afterDelete = await connectorsApi.listCustomConnectors(otherAdmin);
    expect(
      afterDelete.find((connector) => {
        return connector.id === foreign.id;
      }),
    ).toBeUndefined();
  });

  it("keeps custom connector secrets scoped per user and per organization", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user();
    const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
    const adminInOtherOrg = bdd.user({ userId: admin.userId });

    const shared = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(uniqueSlug("bdd-secret")),
    );
    const otherOrg = await connectorsApi.createCustomConnector(
      adminInOtherOrg,
      customConnectorBody(uniqueSlug("bdd-other-secret")),
    );

    async function readHasSecret(
      actor: ApiTestUser,
      connectorId: string,
    ): Promise<boolean | undefined> {
      const connectors = await connectorsApi.listCustomConnectors(actor);
      return connectors.find((connector) => {
        return connector.id === connectorId;
      })?.hasSecret;
    }

    const missing = await connectorsApi.requestSetCustomConnectorSecret(
      admin,
      randomUUID(),
      "unused-secret-value",
      [404],
    );
    expectApiError(missing.body);
    expect(missing.body.error.message).toBe("Custom connector not found");

    await connectorsApi.setCustomConnectorSecret(
      member,
      shared.id,
      "member-secret-value",
    );
    await expect(readHasSecret(member, shared.id)).resolves.toBeTruthy();
    await expect(readHasSecret(admin, shared.id)).resolves.toBeFalsy();

    await connectorsApi.setCustomConnectorSecret(
      admin,
      shared.id,
      "admin-secret-value",
    );
    await connectorsApi.setCustomConnectorSecret(
      admin,
      shared.id,
      "admin-secret-value-rotated",
    );
    const adminList = await connectorsApi.listCustomConnectors(admin);
    expect(
      adminList.find((connector) => {
        return connector.id === shared.id;
      })?.hasSecret,
    ).toBeTruthy();
    expectNoVisibleSecret(adminList, "admin-secret-value");
    expectNoVisibleSecret(adminList, "member-secret-value");

    await connectorsApi.setCustomConnectorSecret(
      adminInOtherOrg,
      otherOrg.id,
      "other-org-secret-value",
    );
    await expect(
      readHasSecret(adminInOtherOrg, otherOrg.id),
    ).resolves.toBeTruthy();

    await connectorsApi.deleteCustomConnectorSecret(admin, shared.id);
    await connectorsApi.deleteCustomConnectorSecret(admin, shared.id);
    await expect(readHasSecret(admin, shared.id)).resolves.toBeFalsy();
    await expect(readHasSecret(member, shared.id)).resolves.toBeTruthy();
    await expect(
      readHasSecret(adminInOtherOrg, otherOrg.id),
    ).resolves.toBeTruthy();

    await connectorsApi.deleteCustomConnector(admin, shared.id);
    await connectorsApi.deleteCustomConnector(adminInOtherOrg, otherOrg.id);
    await expect(readHasSecret(admin, shared.id)).resolves.toBeUndefined();
    await expect(
      readHasSecret(adminInOtherOrg, otherOrg.id),
    ).resolves.toBeUndefined();
  });
});
