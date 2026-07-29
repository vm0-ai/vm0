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

import { randomInt, randomUUID } from "node:crypto";

import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import {
  createBddApi,
  expectApiError,
  type ApiTestUser,
} from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import {
  createConnectorBddApi,
  mockBase44OAuthProvider,
  mockDatadogConnectorOAuth,
  mockDeferredTestOAuthTokenEndpoint,
  mockGitHubConnectorOAuth,
  mockGithubAppInstallProvider,
  mockSlackConnectorOAuth,
  mockSlockOAuthProvider,
  mockStripeCliDashboardAuth,
  mockTestOAuthAuthCodeProvider,
  mockTestOAuthDeviceConnectorProvider,
  requestOauthCallbackRaw,
} from "./helpers/api-bdd-connectors";
import {
  seedConnectorStorageRow,
  setConnectorSecretOwner,
} from "./helpers/connector-credential-storage-state";

const context = testContext();
const connectorsApi = createConnectorBddApi(context);
const authOrgApi = createAuthOrgAgentsBddApi(context);

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

function connectorBySlug(
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

interface RedirectResponseLike {
  readonly headers: Headers;
}

function redirectLocation(response: RedirectResponseLike): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location header");
  }
  return new URL(location);
}

function expectConnectorErrorRedirect(
  response: RedirectResponseLike,
  args: { readonly connectorSlug: string; readonly message: string },
): void {
  const url = redirectLocation(response);
  expect(url.pathname).toBe("/connector/error");
  expect(url.searchParams.get("type")).toBe(args.connectorSlug);
  expect(url.searchParams.get("message")).toBe(args.message);
}

const CONNECTOR_OAUTH_COOKIE_CLEARS = [
  "connector_oauth_state=; Max-Age=0; Path=/",
  "connector_oauth_pkce=; Max-Age=0; Path=/",
  "connector_oauth_context=; Max-Age=0; Path=/",
] as const;

describe("CONN-01 and CHAIN-CONNECTOR: connector discovery and manual grant lifecycle", () => {
  it("authorizes a manual-grant connector for the requested agent in the connect request", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "Manual Connector Agent",
    });

    await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: "manual-agent-token" },
      agent.agentId,
    );

    await expect(
      authOrgApi.readEnabledConnectorSlugs(actor, agent.agentId),
    ).resolves.toContain("openai");
  });

  it("authorizes a manual-grant connector for the current default agent when no agent is requested", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    authOrgApi.acceptAgentStorageWrites();
    const { body } = await authOrgApi.bootstrapLimitedFreeOnboarding(actor, {
      displayName: "Default Connector Agent",
    });

    await connectorsApi.connectManualGrant(actor, "openai", "api-token", {
      apiKey: "default-agent-token",
    });

    await expect(
      authOrgApi.readEnabledConnectorSlugs(actor, body.agentId),
    ).resolves.toContain("openai");
  });

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

    const missingOpenAi = await connectorsApi.requestReadConnectorBySlug(
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
        apiKey: "sk-bdd-manual-secret",
        unknownField: "secret-value-should-not-echo",
      },
      { statuses: [400] },
    );
    expectApiError(badGrant.body);
    expect(badGrant.body.error.message).toContain("apiKey");
    expect(badGrant.body.error.message).not.toContain("unknownField");
    expectNoVisibleSecret(badGrant.body, "secret-value-should-not-echo");

    const connected = await connectorsApi.connectManualGrant(
      actor,
      "openai",
      "api-token",
      { apiKey: " sk-bdd-manual-secret\n" },
    );
    expect(typeof connected.id).toBe("string");
    expectNoVisibleSecret(connected, "sk-bdd-manual-secret");

    const readBack = await connectorsApi.readConnectorBySlug(actor, "openai");
    expect(readBack).toMatchObject({
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
      oauthScopes: null,
    });
    expect(readBack.id).toBe(connected.id);
    expectNoVisibleSecret(readBack, "sk-bdd-manual-secret");

    const listAfterConnect = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listAfterConnect.connectors, "openai")?.id).toBe(
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

    const secretList = await authOrgApi.listSecrets(actor);
    expect(
      secretList.secrets.find((secret) => {
        return secret.name === "OPENAI_TOKEN";
      }),
    ).toMatchObject({
      type: "connector",
      connectorDisplay: {
        label: "OpenAI",
        environmentNames: ["OPENAI_TOKEN"],
      },
    });
    expectNoVisibleSecret(secretList, "sk-bdd-manual-secret");

    const foreignConnectorId = await seedConnectorStorageRow(context, {
      authMethod: "oauth",
      connectorSlug: "github",
      orgId: actor.orgId ?? "",
      storageVersion: 1,
      userId: actor.userId,
    });
    await setConnectorSecretOwner(context, {
      connectorId: foreignConnectorId,
      name: "OPENAI_TOKEN",
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });
    const wrongOwnerSecretList = await authOrgApi.listSecrets(actor);
    expect(
      wrongOwnerSecretList.secrets.find((secret) => {
        return secret.name === "OPENAI_TOKEN";
      })?.connectorDisplay,
    ).toBeNull();
    await setConnectorSecretOwner(context, {
      connectorId: connected.id,
      name: "OPENAI_TOKEN",
      orgId: actor.orgId ?? "",
      userId: actor.userId,
    });

    await expect(
      connectorsApi.readScopeDiff(actor, "openai"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await connectorsApi.deleteConnectorBySlug(actor, "openai");

    const deleted = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "openai",
      [404],
    );
    expectApiError(deleted.body);
    expect(deleted.body.error.code).toBe("NOT_FOUND");
  });
});

describe("CONN-02: OAuth start and callback", () => {
  it("uses App callbacks for enabled connectors while returning structured callback results", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    const startResponse = await connectorsApi.requestOauthStart(
      actor,
      "github",
      "oauth",
      {
        statuses: [200],
        authorizeAgent: true,
        callbackTarget: "app",
      },
    );
    if (startResponse.status !== 200) {
      throw new Error(`Unexpected OAuth start status ${startResponse.status}`);
    }
    const authorizationUrl = new URL(startResponse.body.authorizationUrl);
    expect(
      new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "").pathname,
    ).toBe("/connectors/github/callback");
    const state = stateFromAuthorizationUrl(authorizationUrl.toString());

    const callbackResult = await connectorsApi.completeOauthCallbackResult(
      "github",
      {
        code: "github-app-success-code",
        state,
      },
    );
    expect(callbackResult.body).toStrictEqual({
      status: "success",
      username: "bdd-github-user",
    });
    expect(callbackResult.headers.get("cache-control")).toBe("no-store");
    expect(callbackResult.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );
    await expect(
      connectorsApi.readConnectorBySlug(actor, "github"),
    ).resolves.toMatchObject({
      type: "github",
      externalUsername: "bdd-github-user",
      connectionStatus: "connected",
    });

    const failedActor = bdd.user();
    const failedStartResponse = await connectorsApi.requestOauthStart(
      failedActor,
      "github",
      "oauth",
      {
        statuses: [200],
        authorizeAgent: true,
        callbackTarget: "app",
      },
    );
    if (failedStartResponse.status !== 200) {
      throw new Error(
        `Unexpected OAuth start status ${failedStartResponse.status}`,
      );
    }
    const failedAuthorizationUrl = new URL(
      failedStartResponse.body.authorizationUrl,
    );
    const failedState = stateFromAuthorizationUrl(
      failedAuthorizationUrl.toString(),
    );
    const failedCallbackResult =
      await connectorsApi.completeOauthCallbackResult("github", {
        error: "access_denied",
        error_description: "Provider denied access",
        state: failedState,
      });
    expect(failedCallbackResult.body).toStrictEqual({
      status: "error",
      message: "Provider denied access",
    });
    const failedConnector = await connectorsApi.requestReadConnectorBySlug(
      failedActor,
      "github",
      [404],
    );
    expectApiError(failedConnector.body);
    expect(failedConnector.body.error.code).toBe("NOT_FOUND");
  });

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

    const connected = await connectorsApi.readConnectorBySlug(actor, "github");
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
    const afterReplay = await connectorsApi.readConnectorBySlug(
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
    const failedConnector = await connectorsApi.requestReadConnectorBySlug(
      failedActor,
      "github",
      [404],
    );
    expectApiError(failedConnector.body);
    expect(failedConnector.body.error.code).toBe("NOT_FOUND");
  });

  it("persists the callback-selected Datadog site through the public OAuth flow", async () => {
    const provider = mockDatadogConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.DatadogConnector]: true,
    });

    const start = await connectorsApi.startOauth(actor, "datadog", "oauth");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const callback = await connectorsApi.completeOauthCallback("datadog", {
      code: "datadog-success-code",
      state,
      domain: "us3.datadoghq.com",
    });
    expect(redirectLocation(callback).pathname).toBe("/connector/success");

    expect(provider.tokenBodies).toHaveLength(1);
    expect(provider.tokenBodies[0]?.get("code")).toBe("datadog-success-code");
    const codeVerifier = provider.tokenBodies[0]?.get("code_verifier");
    expect(codeVerifier).toStrictEqual(expect.any(String));
    expect(codeVerifier?.length).toBeGreaterThanOrEqual(43);

    const connected = await connectorsApi.readConnectorBySlug(actor, "datadog");
    expect(connected).toMatchObject({
      type: "datadog",
      authMethod: "oauth",
      externalId: "us3.datadoghq.com",
      externalUsername: "us3.datadoghq.com",
      oauthScopes: [
        "dashboards_read",
        "events_read",
        "incident_read",
        "logs_read_index_data",
        "metrics_read",
        "monitors_read",
        "slos_read",
      ],
      connectionStatus: "connected",
    });
    expectNoVisibleSecret(connected, "bdd-datadog-access-token");
    expectNoVisibleSecret(connected, "bdd-datadog-refresh-token");
  });

  it("rejects OAuth start requests that target unsupported auth methods", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const unauthenticated = await connectorsApi.requestOauthStart(
      null,
      "github",
      "oauth",
      { statuses: [401] },
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const wrongGrant = await connectorsApi.requestOauthStart(
      actor,
      "openai",
      "api-token",
      { statuses: [400] },
    );
    expectApiError(wrongGrant.body);
    expect(wrongGrant.body.error.message).toContain(
      "openai connector does not use an auth-code grant",
    );

    const missingMethod = await connectorsApi.requestOauthStart(
      actor,
      "github",
      "api-token",
      { statuses: [400] },
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

    const readBack = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(poll.connector.id);

    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listed.connectors, "test-oauth-device")?.id).toBe(
      poll.connector.id,
    );

    await connectorsApi.deleteConnectorBySlug(actor, "test-oauth-device");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("starts and completes the Stripe CLI device authorization method", async () => {
    const stripeProvider = mockStripeCliDashboardAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const session = await connectorsApi.startDeviceAuth(
      actor,
      "stripe",
      "cli",
      { mode: "live" },
    );
    expect(session).toMatchObject({
      type: "stripe",
      status: "pending",
      userCode: "STRIPE-CLI",
      verificationUri:
        "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI",
      verificationUriComplete:
        "https://dashboard.stripe.com/stripecli/confirm_auth?code=STRIPE-CLI",
      expiresIn: 600,
      interval: 1,
    });
    expect(stripeProvider.startBodies[0]?.get("client_version")).toBe("1.42.1");
    expect(stripeProvider.startBodies[0]?.get("device_name")).toBe(
      "vm0-stripe-connector",
    );

    mockNow(now() + 2000);
    const poll = await connectorsApi.pollDeviceAuth(
      actor,
      "stripe",
      session.sessionId,
      session.sessionToken,
    );
    expect(poll.status).toBe("complete");
    if (poll.status !== "complete") {
      throw new Error(
        `Expected complete Stripe device auth, got ${poll.status}`,
      );
    }
    expect(poll.connector).toMatchObject({
      type: "stripe",
      authMethod: "cli",
      externalId: "acct_bdd",
      externalUsername: "BDD Stripe",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected",
    });
    expect(JSON.stringify(poll)).not.toContain("rk_live_api456");
    expect(stripeProvider.pollCount()).toBe(1);
    clearMockNow();

    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listed.connectors, "stripe")?.id).toBe(
      poll.connector.id,
    );
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "stripe",
        authMethod: "cli",
        namespace: "secrets",
        name: "STRIPE_TOKEN",
      }),
    );

    await connectorsApi.deleteConnectorBySlug(actor, "stripe");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("validates device-auth identity, grant, options, and session boundaries without using rollout as authorization", async () => {
    const testOauthProvider = mockTestOAuthDeviceConnectorProvider();
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
      { environment: "production" },
      [400],
    );
    expectApiError(invalidOptionValue.body);
    expect(invalidOptionValue.body.error.message).toBe(
      "test-oauth-device api device-auth start option environment must be one of: test, live",
    );

    const privateOptionKey = await connectorsApi.requestDeviceAuthStart(
      actor,
      "test-oauth-device",
      "api",
      { mode: "live" },
      [400],
    );
    expectApiError(privateOptionKey.body);
    expect(privateOptionKey.body.error.message).toBe(
      "test-oauth-device api device-auth start option(s) must use public IDs: environment",
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
      "test-oauth-device api device-auth start option(s) must use public IDs: environment",
    );

    const stripeDeviceAuth = await connectorsApi.requestDeviceAuthStart(
      actor,
      "stripe",
      "cli",
      { mode: "production" },
      [400],
    );
    expectApiError(stripeDeviceAuth.body);
    expect(stripeDeviceAuth.body.error.message).toBe(
      "stripe cli device-auth start option mode must be one of: test, live",
    );

    const switchlessStart = await connectorsApi.requestDeviceAuthStart(
      switchlessActor,
      "test-oauth-device",
      "oauth",
      undefined,
      [200],
    );
    expect(switchlessStart.body).toMatchObject({
      type: "test-oauth-device",
      status: "pending",
    });
    expect(testOauthProvider.deviceCodeBodies).toHaveLength(1);

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
      environment: "live",
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

    await connectorsApi.deleteConnectorBySlug(actor, "test-oauth-device");

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

    const readBack = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(completed.connector.id);
    const listed = await connectorsApi.listConnectors(actor);
    expect(connectorBySlug(listed.connectors, "test-oauth-device")?.id).toBe(
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

    await connectorsApi.deleteConnectorBySlug(actor, "test-oauth-device");
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

    const nothingPersisted = await connectorsApi.requestReadConnectorBySlug(
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

    const base44Connector = await connectorsApi.readConnectorBySlug(
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
    await connectorsApi.deleteConnectorBySlug(actor, "base44");

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

    const slockConnector = await connectorsApi.readConnectorBySlug(
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
    await connectorsApi.deleteConnectorBySlug(actor, "slock");

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

  it("continues polls after the connector feature switch is disabled", async () => {
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

    const continuedPoll = await connectorsApi.requestDeviceAuthPoll(
      actor,
      "test-oauth-device",
      session.sessionId,
      session.sessionToken,
      [200],
    );
    expect(continuedPoll.body).toStrictEqual({
      status: "pending",
      interval: 0,
    });
  });
});

describe("CONN-02: external-code authorization", () => {
  it("validates external-code auth, grant, and session boundaries without using rollout as authorization", async () => {
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

    const switchlessStart = await connectorsApi.requestExternalCodeStart(
      actor,
      "aws",
      "cli",
      [200],
    );
    expect(switchlessStart.body).toMatchObject({
      type: "aws",
      status: "pending",
    });

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

  it("saves a connector proposal with values and authorizes the requested agent", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Proposal Agent",
    });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "BDD Proposal API",
        prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
        fields: [
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [
          {
            name: "tenant",
            valueTemplate: "{{variables.subdomain}}",
          },
        ],
      },
      values: [
        { key: "api_key", kind: "secret", value: "proposal-secret" },
        { key: "subdomain", kind: "variable", value: "acme" },
      ],
      agentId: agent.agentId,
    });

    expect(saved.authorizedAgentId).toBe(agent.agentId);
    expect(saved.connector).toMatchObject({
      displayName: "BDD Proposal API",
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["api_key", "subdomain"],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([saved.connector.id]);

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed.find((connector) => {
        return connector.id === saved.connector.id;
      }),
    ).toMatchObject({
      connected: true,
      configuredFieldKeys: ["api_key", "subdomain"],
    });
    expectNoVisibleSecret(listed, "proposal-secret");

    await connectorsApi.deleteCustomConnector(admin, saved.connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("saves a connector proposal without authorizing when required values are missing", async () => {
    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user({ orgRole: "org:admin" });
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD Missing Proposal Value Agent",
    });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "BDD Missing Proposal Value API",
        prefixTemplates: [`https://${rand}.example.test/v1/`],
        fields: [
          {
            key: "api_key",
            label: "API key",
            kind: "secret",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      },
      values: [],
      agentId: agent.agentId,
    });

    expect(saved.authorizedAgentId).toBeUndefined();
    expect(saved.connector).toMatchObject({
      connected: false,
      missingRequiredFields: ["api_key"],
      configuredFieldKeys: [],
    });
    await expect(
      connectorsApi.readAgentCustomConnectors(admin, agent.agentId),
    ).resolves.toStrictEqual([]);

    await connectorsApi.deleteCustomConnector(admin, saved.connector.id);
    await bdd.deleteAgent(admin, agent.agentId);
  });

  it("rejects connector proposal host variables that change URL structure", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const rejected = await connectorsApi.requestSaveCustomConnectorProposal(
      admin,
      {
        proposal: {
          operation: "create",
          displayName: "BDD Unsafe Proposal API",
          prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
          fields: [
            {
              key: "api_key",
              label: "API key",
              kind: "secret",
              required: true,
            },
            {
              key: "subdomain",
              label: "Subdomain",
              kind: "variable",
              required: true,
            },
          ],
          headerInjections: [
            {
              name: "Authorization",
              valueTemplate: "Bearer {{secrets.api_key}}",
            },
          ],
          queryInjections: [],
        },
        values: [
          { key: "api_key", kind: "secret", value: "unsafe-secret" },
          { key: "subdomain", kind: "variable", value: "evil.test/path" },
        ],
      },
      [400],
    );

    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain(
      "not safe in custom connector host templates",
    );
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("rejects runtime-dependent custom connector hostnames at API boundaries", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    for (const host of ["\u088f.example", "xn--7xb.example"]) {
      const definition = await connectorsApi.requestCreateCustomConnector(
        admin,
        {
          ...customConnectorBody(uniqueSlug("invalid-hostname")),
          prefixes: [`https://${host}/v1/`],
        },
        [400],
      );
      expectApiError(definition.body);
      expect(definition.body.error.message).toContain("vm0-uts46-16.0-v1");

      const proposal = await connectorsApi.requestSaveCustomConnectorProposal(
        admin,
        {
          proposal: {
            operation: "create",
            displayName: "BDD Invalid Hostname API",
            prefixTemplates: [
              `https://{{variables.subdomain}}.${rand}.test/v1/`,
            ],
            fields: [
              {
                key: "api_key",
                label: "API key",
                kind: "secret",
                required: true,
              },
              {
                key: "subdomain",
                label: "Subdomain",
                kind: "variable",
                required: true,
              },
            ],
            headerInjections: [
              {
                name: "Authorization",
                valueTemplate: "Bearer {{secrets.api_key}}",
              },
            ],
            queryInjections: [],
          },
          values: [
            { key: "api_key", kind: "secret", value: "invalid-host-secret" },
            { key: "subdomain", kind: "variable", value: host },
          ],
        },
        [400],
      );
      expectApiError(proposal.body);
      expect(proposal.body.error.message).toContain(
        "not a valid custom connector hostname",
      );
      expectNoVisibleSecret(proposal.body, "invalid-host-secret");
    }

    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("preserves valid Unicode prefixes while deriving a canonical default slug", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rawPrefix = "https://münich.example/v1/";

    const connector = await connectorsApi.createCustomConnector(admin, {
      displayName: "BDD Unicode Host API",
      prefixes: [rawPrefix],
      headerName: "Authorization",
      headerTemplate: "Bearer {{secret}}",
    });

    expect(connector.prefixes).toStrictEqual([rawPrefix]);
    expect(connector.prefixTemplates).toStrictEqual([rawPrefix]);
    expect(connector.slug).toMatch(/^xn-mnich-kva-example-[a-z0-9]{6}$/);

    await connectorsApi.deleteCustomConnector(admin, connector.id);
    await expect(
      connectorsApi.listCustomConnectors(admin),
    ).resolves.toStrictEqual([]);
  });

  it("rejects invalid hostname updates without changing the connector", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const original = await connectorsApi.createCustomConnector(
      admin,
      customConnectorBody(uniqueSlug("hostname-update")),
    );

    const rejected = await connectorsApi.requestSaveCustomConnectorProposal(
      admin,
      {
        proposal: {
          operation: "update",
          connectorId: original.id,
          displayName: "BDD Invalid Hostname Update",
          prefixTemplates: ["https://\u088f.example/v2/"],
          fields: original.fields,
          headerInjections: original.headerInjections,
          queryInjections: original.queryInjections,
        },
        values: [],
      },
      [400],
    );
    expectApiError(rejected.body);
    expect(rejected.body.error.message).toContain("vm0-uts46-16.0-v1");

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(listed).toContainEqual(original);

    await connectorsApi.deleteCustomConnector(admin, original.id);
  });

  it("deletes only the legacy secret value through the legacy secret endpoint", async () => {
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const rand = randomUUID().replace(/-/g, "").slice(0, 8);

    const saved = await connectorsApi.saveCustomConnectorProposal(admin, {
      proposal: {
        operation: "create",
        displayName: "BDD Legacy Delete API",
        prefixTemplates: [`https://{{variables.subdomain}}.${rand}.test/v1/`],
        fields: [
          {
            key: "secret",
            label: "API key",
            kind: "secret",
            required: true,
          },
          {
            key: "subdomain",
            label: "Subdomain",
            kind: "variable",
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [
          {
            name: "tenant",
            valueTemplate: "{{variables.subdomain}}",
          },
        ],
      },
      values: [
        { key: "secret", kind: "secret", value: "legacy-delete-secret" },
        { key: "subdomain", kind: "variable", value: "acme" },
      ],
    });

    await connectorsApi.deleteCustomConnectorSecret(admin, saved.connector.id);

    const listed = await connectorsApi.listCustomConnectors(admin);
    expect(
      listed.find((connector) => {
        return connector.id === saved.connector.id;
      }),
    ).toMatchObject({
      connected: false,
      configuredFieldKeys: ["subdomain"],
      missingRequiredFields: ["secret"],
    });

    await connectorsApi.deleteCustomConnector(admin, saved.connector.id);
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

    const builtinTrailingDotCollision =
      await connectorsApi.requestCreateCustomConnector(
        admin,
        {
          displayName: "Fake GitHub Trailing Dot",
          prefixes: ["https://api.github.com./v3/"],
          headerName: "Authorization",
          headerTemplate: "Bearer {{secret}}",
        },
        [400],
      );
    expectApiError(builtinTrailingDotCollision.body);
    expect(builtinTrailingDotCollision.body.error.message).toContain(
      "api.github.com.",
    );
    expect(builtinTrailingDotCollision.body.error.message).toContain("GitHub");

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

describe("CONN-02: OAuth callback validation and state claiming", () => {
  it("rejects malformed and unclaimable callbacks through visible redirects", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const unknownType = await connectorsApi.completeOauthCallback("invalid", {
      code: "code-123",
      state: "state-123",
    });
    expectConnectorErrorRedirect(unknownType, {
      connectorSlug: "invalid",
      message: "Unknown connector type",
    });

    const manualOnly = await connectorsApi.completeOauthCallback("cloudinary", {
      code: "code-123",
      state: "state-123",
    });
    expectConnectorErrorRedirect(manualOnly, {
      connectorSlug: "cloudinary",
      message: "cloudinary connector does not use an auth-code grant",
    });

    const deviceOnly = await connectorsApi.completeOauthCallback(
      "test-oauth-device",
      { code: "code-123", state: "state-123" },
    );
    expectConnectorErrorRedirect(deviceOnly, {
      connectorSlug: "test-oauth-device",
      message: "test-oauth-device connector does not use an auth-code grant",
    });

    const unclaimable = await connectorsApi.completeOauthCallback("github", {
      code: "code-123",
      state: "bdd-never-stored-state",
    });
    expectConnectorErrorRedirect(unclaimable, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });
    expect(unclaimable.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );

    const missingState = await connectorsApi.completeOauthCallback("github", {
      code: "code-123",
    });
    expectConnectorErrorRedirect(missingState, {
      connectorSlug: "github",
      message: "Missing state parameter",
    });

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const crossType = await connectorsApi.completeOauthCallback("linear", {
      code: "code-123",
      state,
    });
    expectConnectorErrorRedirect(crossType, {
      connectorSlug: "linear",
      message: "Invalid state - please try again",
    });

    const success = await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });
    const successUrl = redirectLocation(success);
    expect(successUrl.pathname).toBe("/connector/success");
    expect(successUrl.searchParams.get("type")).toBe("github");
    expect(successUrl.searchParams.get("username")).toBe("bdd-github-user");

    const connected = await connectorsApi.readConnectorBySlug(actor, "github");
    expect(connected).toMatchObject({
      type: "github",
      authMethod: "oauth",
      connectionStatus: "connected",
    });

    const linearMissing = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "linear",
      [404],
    );
    expectApiError(linearMissing.body);
    expect(linearMissing.body.error.code).toBe("NOT_FOUND");
  });

  it("claims, preserves, and invalidates stored OAuth state across code-less, error, and expired callbacks", async () => {
    mockGitHubConnectorOAuth();

    const bdd = createBddApi(context);
    const actor = bdd.user();

    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    const missingCode = await connectorsApi.completeOauthCallback("github", {
      state,
    });
    expectConnectorErrorRedirect(missingCode, {
      connectorSlug: "github",
      message: "Missing authorization code",
    });
    expect(missingCode.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );

    const unknownState = await connectorsApi.completeOauthCallback("github", {
      state: "bdd-unknown-state",
    });
    expectConnectorErrorRedirect(unknownState, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const success = await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });
    const successUrl = redirectLocation(success);
    expect(successUrl.pathname).toBe("/connector/success");
    expect(successUrl.searchParams.get("username")).toBe("bdd-github-user");

    const connected = await connectorsApi.readConnectorBySlug(actor, "github");

    const consumedWithoutCode = await connectorsApi.completeOauthCallback(
      "github",
      { state },
    );
    expectConnectorErrorRedirect(consumedWithoutCode, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const consumedProviderError = await connectorsApi.completeOauthCallback(
      "github",
      {
        error: "access_denied",
        error_description: "Provider denied access",
        state,
      },
    );
    expectConnectorErrorRedirect(consumedProviderError, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });

    const stable = await connectorsApi.readConnectorBySlug(actor, "github");
    expect(stable.id).toBe(connected.id);
    expect(stable.externalUsername).toBe("bdd-github-user");

    const expiringStart = await connectorsApi.startOauth(
      actor,
      "github",
      "oauth",
    );
    const expiringState = stateFromAuthorizationUrl(
      expiringStart.authorizationUrl,
    );
    mockNow(now() + 16 * 60 * 1000);
    const expired = await connectorsApi.completeOauthCallback("github", {
      code: "github-late-code",
      state: expiringState,
    });
    expectConnectorErrorRedirect(expired, {
      connectorSlug: "github",
      message: "Invalid state - please try again",
    });
    clearMockNow();

    const afterExpiry = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "github",
      [404],
    );
    expectApiError(afterExpiry.body);
    expect(afterExpiry.body.error.code).toBe("NOT_FOUND");
  });

  it("routes callbacks through canonical and trusted web origins", async () => {
    mockEnv("VM0_WEB_URL", "https://app.vm0.test");

    const canonical = await requestOauthCallbackRaw(context, {
      origin: "https://api.vm0.ai",
      connectorSlug: "github",
      query: { code: "code-123", state: "state-123" },
    });
    expect(canonical.status).toBe(307);
    expect(canonical.headers.get("location")).toBe(
      "https://www.vm0.ai/api/connectors/github/callback?code=code-123&state=state-123",
    );

    const trustedHeader = await requestOauthCallbackRaw(context, {
      origin: "https://api.vm0.ai",
      connectorSlug: "github",
      query: { code: "code-123" },
      headers: { "x-vm0-web-origin": "https://www.vm0.ai" },
    });
    expect(trustedHeader.status).toBe(307);
    const trustedUrl = redirectLocation(trustedHeader);
    expect(trustedUrl.origin).toBe("https://app.vm0.test");
    expectConnectorErrorRedirect(trustedHeader, {
      connectorSlug: "github",
      message: "Missing state parameter",
    });

    const nonApiHost = await requestOauthCallbackRaw(context, {
      origin: "https://app.vm0.test",
      connectorSlug: "github",
      query: { code: "code-123" },
    });
    expect(nonApiHost.status).toBe(307);
    const nonApiUrl = redirectLocation(nonApiHost);
    expect(nonApiUrl.origin).toBe("https://app.vm0.test");
    expectConnectorErrorRedirect(nonApiHost, {
      connectorSlug: "github",
      message: "Missing state parameter",
    });
  });
});

describe("CONN-02: test-oauth auth-code journey", () => {
  it("replaces a manual-grant connection through the auth-code callback with method-scoped state cleanup", async () => {
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    const provider = mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-test-oauth-refresh",
    });

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const agent = await authOrgApi.createAgent(actor, {
      displayName: "OAuth Connector Agent",
    });

    const start = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
      agent.agentId,
    );
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "http://localhost:3000/api/test/oauth-provider/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "test-oauth-client",
    );
    const state = stateFromAuthorizationUrl(start.authorizationUrl);

    await connectorsApi.connectManualGrant(actor, "test-oauth", "api-token", {
      apiToken: "bdd-manual-test-oauth-token",
      inputVariable: "bdd-input-variable",
      tenantId: "bdd-manual-tenant",
    });
    const manual = await connectorsApi.readConnectorBySlug(actor, "test-oauth");
    expect(manual.authMethod).toBe("api-token");

    const success = await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-test-oauth-code",
      state,
    });
    const successUrl = redirectLocation(success);
    expect(successUrl.pathname).toBe("/connector/success");
    expect(successUrl.searchParams.get("type")).toBe("test-oauth");
    expect(successUrl.searchParams.get("username")).toBe("bdd-test-oauth");

    expect(provider.tokenBodies).toHaveLength(1);
    const exchangeBody = provider.tokenBodies[0];
    expect(exchangeBody?.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody?.get("client_id")).toBe("test-oauth-client");
    expect(exchangeBody?.get("client_secret")).toBe("test-oauth-secret");
    expect(exchangeBody?.get("code")).toBe("bdd-test-oauth-code");
    expect(exchangeBody?.get("redirect_uri")).toBe(
      "https://api.vm0.ai/api/connectors/test-oauth/callback",
    );

    const oauthConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(oauthConnector).toMatchObject({
      type: "test-oauth",
      authMethod: "oauth",
      externalId: "bdd-test-oauth-user",
      externalUsername: "bdd-test-oauth",
      externalEmail: "bdd-test-oauth@example.test",
      oauthScopes: ["read"],
      connectionStatus: "connected",
    });
    expectNoVisibleSecret(oauthConnector, "bdd-test-oauth-access-token");
    await expect(
      authOrgApi.readEnabledConnectorSlugs(actor, agent.agentId),
    ).resolves.toContain("test-oauth");

    const listed = await connectorsApi.listConnectors(actor);
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "test-oauth",
        authMethod: "oauth",
        namespace: "secrets",
        name: "TEST_OAUTH_TOKEN",
        source: { kind: "connector-secret", name: "TEST_OAUTH_ACCESS_TOKEN" },
      }),
    );
    expect(listed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "test-oauth",
        authMethod: "oauth",
        namespace: "vars",
        name: "TEST_OAUTH_TENANT_ID",
        source: {
          kind: "connector-variable",
          name: "TEST_OAUTH_API_TENANT_ID",
        },
      }),
    );
    expect(
      listed.connectorProvidedBindings.filter((binding) => {
        return (
          binding.connectorType === "test-oauth" &&
          binding.authMethod === "api-token"
        );
      }),
    ).toStrictEqual([]);
    expectNoVisibleSecret(listed, "bdd-manual-test-oauth-token");
    expectNoVisibleSecret(listed, "bdd-test-oauth-access-token");

    await expect(
      connectorsApi.readScopeDiff(actor, "test-oauth"),
    ).resolves.toStrictEqual({
      addedScopes: [],
      removedScopes: [],
      currentScopes: ["read"],
      storedScopes: ["read"],
    });

    const apiProvider = mockTestOAuthAuthCodeProvider({
      accessToken: "bdd-test-oauth-api-access-token",
      refreshToken: "bdd-test-oauth-api-refresh",
    });
    const apiStart = await connectorsApi.startOauth(actor, "test-oauth", "api");
    const apiState = stateFromAuthorizationUrl(apiStart.authorizationUrl);
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-test-oauth-api-code",
      state: apiState,
    });
    expect(apiProvider.tokenBodies).toHaveLength(1);

    const apiConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    expect(apiConnector.authMethod).toBe("api");

    const apiListed = await connectorsApi.listConnectors(actor);
    expect(apiListed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "test-oauth",
        authMethod: "api",
        namespace: "secrets",
        name: "TEST_OAUTH_TOKEN",
        source: {
          kind: "connector-secret",
          name: "TEST_OAUTH_API_ACCESS_TOKEN",
        },
      }),
    );
    expectNoVisibleSecret(apiListed, "bdd-test-oauth-api-access-token");

    await connectorsApi.deleteConnectorBySlug(actor, "test-oauth");
    await connectorsApi.deleteFeatureSwitches(actor);
  });

  it("stores token expiry variants and surfaces provider failures", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-refresh-v1",
      expiresIn: 7200,
    });
    const explicitStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    const explicitBefore = now();
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-v1",
      state: stateFromAuthorizationUrl(explicitStart.authorizationUrl),
    });
    const explicitAfter = now();
    const explicitExpiry = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    if (!explicitExpiry.tokenExpiresAt) {
      throw new Error("Expected an explicit token expiry to be stored");
    }
    const explicitExpiryMs = Date.parse(explicitExpiry.tokenExpiresAt);
    expect(explicitExpiryMs).toBeGreaterThanOrEqual(
      explicitBefore + 7200 * 1000,
    );
    expect(explicitExpiryMs).toBeLessThanOrEqual(explicitAfter + 7200 * 1000);

    mockTestOAuthAuthCodeProvider({
      refreshToken: "bdd-refresh-v2",
      omitExpiresIn: true,
    });
    const defaultStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    const defaultBefore = now();
    await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-v2",
      state: stateFromAuthorizationUrl(defaultStart.authorizationUrl),
    });
    const defaultAfter = now();
    const defaultExpiry = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth",
    );
    if (!defaultExpiry.tokenExpiresAt) {
      throw new Error("Expected the default token expiry to be stored");
    }
    const defaultExpiryMs = Date.parse(defaultExpiry.tokenExpiresAt);
    expect(defaultExpiryMs).toBeGreaterThanOrEqual(
      defaultBefore + 15 * 60 * 1000,
    );
    expect(defaultExpiryMs).toBeLessThanOrEqual(defaultAfter + 15 * 60 * 1000);

    mockSlackConnectorOAuth();
    const slackStart = await connectorsApi.startOauth(actor, "slack", "oauth");
    await connectorsApi.completeOauthCallback("slack", {
      code: "bdd-slack-code",
      state: stateFromAuthorizationUrl(slackStart.authorizationUrl),
    });
    const slackConnector = await connectorsApi.readConnectorBySlug(
      actor,
      "slack",
    );
    expect(slackConnector).toMatchObject({
      type: "slack",
      authMethod: "oauth",
      externalId: "U012AB3CD",
      externalUsername: "BDD Slack User",
      connectionStatus: "connected",
    });
    expect(slackConnector.tokenExpiresAt).toBeNull();
    expectNoVisibleSecret(slackConnector, "xoxp-bdd-user-token");

    mockTestOAuthAuthCodeProvider({ tokenError: true });
    const tokenFailStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    const tokenFail = await connectorsApi.completeOauthCallback("test-oauth", {
      code: "bdd-code-token-fail",
      state: stateFromAuthorizationUrl(tokenFailStart.authorizationUrl),
    });
    expectConnectorErrorRedirect(tokenFail, {
      connectorSlug: "test-oauth",
      message: "OAuth authorization failed. Please try again.",
    });
    expect(tokenFail.headers.getSetCookie()).toStrictEqual(
      expect.arrayContaining([...CONNECTOR_OAUTH_COOKIE_CLEARS]),
    );
    const afterTokenFail = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "test-oauth",
      [404],
    );
    expectApiError(afterTokenFail.body);
    expect(afterTokenFail.body.error.code).toBe("NOT_FOUND");

    mockTestOAuthAuthCodeProvider({ userinfoError: true });
    const userinfoFailStart = await connectorsApi.startOauth(
      actor,
      "test-oauth",
      "oauth",
    );
    const userinfoFail = await connectorsApi.completeOauthCallback(
      "test-oauth",
      {
        code: "bdd-code-userinfo-fail",
        state: stateFromAuthorizationUrl(userinfoFailStart.authorizationUrl),
      },
    );
    expectConnectorErrorRedirect(userinfoFail, {
      connectorSlug: "test-oauth",
      message: "OAuth authorization failed. Please try again.",
    });
    const afterUserinfoFail = await connectorsApi.requestReadConnectorBySlug(
      actor,
      "test-oauth",
      [404],
    );
    expectApiError(afterUserinfoFail.body);
    expect(afterUserinfoFail.body.error.code).toBe("NOT_FOUND");

    await connectorsApi.deleteConnectorBySlug(actor, "slack");
    await connectorsApi.deleteFeatureSwitches(actor);
  });
});

describe("CONN-02: device-auth method switching", () => {
  it("switches device-auth methods without deleting the connector", async () => {
    mockTestOAuthDeviceConnectorProvider();

    const bdd = createBddApi(context);
    const actor = bdd.user();
    await connectorsApi.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });

    const apiSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "api",
    );
    const apiPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      apiSession.sessionId,
      apiSession.sessionToken,
    );
    expect(apiPoll.status).toBe("complete");
    if (apiPoll.status !== "complete") {
      throw new Error(
        `Expected complete api device auth, received ${apiPoll.status}`,
      );
    }
    expect(apiPoll.connector.authMethod).toBe("api");

    const apiListed = await connectorsApi.listConnectors(actor);
    expect(apiListed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "test-oauth-device",
        authMethod: "api",
        namespace: "secrets",
        name: "TEST_OAUTH_DEVICE_API_TOKEN",
      }),
    );

    const oauthSession = await connectorsApi.startDeviceAuth(
      actor,
      "test-oauth-device",
      "oauth",
    );
    const oauthPoll = await connectorsApi.pollDeviceAuth(
      actor,
      "test-oauth-device",
      oauthSession.sessionId,
      oauthSession.sessionToken,
    );
    expect(oauthPoll.status).toBe("complete");
    if (oauthPoll.status !== "complete") {
      throw new Error(
        `Expected complete oauth device auth, received ${oauthPoll.status}`,
      );
    }
    expect(oauthPoll.connector.authMethod).toBe("oauth");

    const readBack = await connectorsApi.readConnectorBySlug(
      actor,
      "test-oauth-device",
    );
    expect(readBack.id).toBe(apiPoll.connector.id);
    expect(readBack.authMethod).toBe("oauth");

    const oauthListed = await connectorsApi.listConnectors(actor);
    expect(
      oauthListed.connectorProvidedBindings.filter((binding) => {
        return (
          binding.connectorType === "test-oauth-device" &&
          binding.authMethod === "api"
        );
      }),
    ).toStrictEqual([]);
    expect(oauthListed.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorType: "test-oauth-device",
        authMethod: "oauth",
        namespace: "secrets",
        name: "TEST_OAUTH_DEVICE_TOKEN",
      }),
    );

    await connectorsApi.deleteConnectorBySlug(actor, "test-oauth-device");
    await connectorsApi.deleteFeatureSwitches(actor);
  });
});

describe("CONN-02: GitHub installation link after connector OAuth", () => {
  it("links the org GitHub installation when the GitHub connector completes OAuth", async () => {
    mockGitHubConnectorOAuth();
    const installationId = String(randomInt(100_000_000, 999_999_999));
    const targetId = String(randomInt(100_000_000, 999_999_999));
    mockGithubAppInstallProvider({ installationId, targetId });

    const bdd = createBddApi(context);
    bdd.acceptAgentStorageWrites();
    const admin = bdd.user();
    const agent = await bdd.createAgent(admin, {
      displayName: "BDD GitHub Link Agent",
    });

    await connectorsApi.installGithubAppViaApi(
      admin,
      agent.agentId,
      installationId,
    );

    const beforeLink = await connectorsApi.readGithubIntegration(admin);
    expect(beforeLink.installation).toMatchObject({
      installationId,
      status: "active",
      targetType: "Organization",
      targetName: "bdd-github-org",
      isAdmin: true,
    });
    expect(beforeLink.isConnected).toBeFalsy();
    expect(beforeLink.connectedGithubUserId).toBeNull();

    const start = await connectorsApi.startOauth(admin, "github", "oauth");
    const state = stateFromAuthorizationUrl(start.authorizationUrl);
    const success = await connectorsApi.completeOauthCallback("github", {
      code: "github-success-code",
      state,
    });
    expect(redirectLocation(success).pathname).toBe("/connector/success");

    const afterLink = await connectorsApi.readGithubIntegration(admin);
    expect(afterLink.isConnected).toBeTruthy();
    expect(afterLink.connectedGithubUserId).toBe("42");
    expect(afterLink.connectedGithubUsername).toBe("bdd-github-user");

    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "github:changed",
      null,
    );

    await connectorsApi.deleteConnectorBySlug(admin, "github");
  });
});
