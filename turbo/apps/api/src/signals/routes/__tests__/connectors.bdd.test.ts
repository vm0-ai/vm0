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
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
  mockTestOAuthDeviceConnectorProvider,
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
});
