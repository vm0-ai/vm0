import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogListResponse,
  type PublicConnectorCatalogStatusResponse,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const authDevice = createAuthDeviceApiActions(context);
const store = createStore();

async function enableFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  const client = setupApp({ context })(zeroFeatureSwitchesContract);
  await accept(
    client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  const client = setupApp({ context })(zeroFeatureSwitchesContract);
  await accept(
    client.delete({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function assertCategoryMetadataMatchesVisibleConnectors(
  body:
    | PublicConnectorCatalogListResponse
    | PublicConnectorCatalogStatusResponse,
): void {
  const metadata = body.categoryMetadata;
  expect(metadata).toBeDefined();
  if (!metadata) {
    return;
  }
  const connectorCategories = new Set(
    body.connectors.map((connector) => {
      return connector.category;
    }),
  );
  expect(
    new Set(
      metadata.categories.map((category) => {
        return category.id;
      }),
    ),
  ).toStrictEqual(connectorCategories);

  const aiCategoryIndex = metadata.categories.findIndex((category) => {
    return category.id === "ai-general-models";
  });
  const engineeringCategoryIndex = metadata.categories.findIndex((category) => {
    return category.id === "engineering-team-execution";
  });
  expect(aiCategoryIndex).toBeGreaterThanOrEqual(0);
  expect(engineeringCategoryIndex).toBeGreaterThanOrEqual(0);
  expect(aiCategoryIndex).toBeLessThan(engineeringCategoryIndex);
  expect(metadata.categories[aiCategoryIndex]).toMatchObject({
    id: "ai-general-models",
    label: "General Models and Reasoning",
    menuLabel: "General Models",
    groupId: "ai",
  });
  expect(metadata.groups).toContainEqual({
    id: "ai",
    label: "AI",
    menuLabel: "AI",
  });
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

describe("GET /api/zero/connector-catalog", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  async function enableConnectorFeatureSwitches(
    orgId: string,
    userId: string,
    switches: Partial<Record<FeatureSwitchKey, boolean>>,
  ): Promise<void> {
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, switches);
  }

  afterEach(async () => {
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await deleteFeatureSwitches(fixture.orgId, fixture.userId);
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns public catalog metadata without a catalog feature switch", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    assertCategoryMetadataMatchesVisibleConnectors(response.body);
    expect(response.body.connectors.length).toBeGreaterThan(0);
  });

  it("returns compact public connector metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.connectors.length).toBeGreaterThan(0);
    const openai = response.body.connectors.find((connector) => {
      return connector.connectorRef === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai?.label).toBe("OpenAI");
    expect(openai?.generation).toContain("text");
    expect(openai?.tags).toContain("llm");
    expect(openai?.authMethods).toStrictEqual([
      {
        id: "api-token",
        label: "API Key",
        description: expect.any(String),
        grantKind: "manual",
      },
    ]);
    expect(openai?.permissionSummary).toStrictEqual({
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    });
    expect(openai?.permissionSummary).not.toHaveProperty("permissions");
  });

  it("accepts a ZERO_TOKEN carrying the connector:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThan(0);
  });

  it("rejects a ZERO_TOKEN missing the connector:read capability with 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns 401 for catalog status when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(client.status({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for catalog status when the session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects catalog status ZERO_TOKEN calls without connector:read", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns public catalog status without private connector fields", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    assertCategoryMetadataMatchesVisibleConnectors(response.body);
    const openai = response.body.connectors.find((connector) => {
      return connector.connectorRef === "openai";
    });
    expect(openai).toMatchObject({
      connectorRef: "openai",
      label: "OpenAI",
      connected: false,
      connection: null,
      connectionStatus: "not-connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
      singleAuthCodeAuthMethodId: null,
      connectNotice: null,
    });
    expect(openai?.authMethods).toStrictEqual([
      {
        id: "api-token",
        label: "API Key",
        description: expect.any(String),
        grantKind: "manual",
        manualFields: [
          {
            id: "apiKey",
            label: "API Key",
            required: true,
            placeholder: "sk-...",
            inputType: "password",
          },
        ],
        startOptions: [],
      },
    ]);
    const neon = response.body.connectors.find((connector) => {
      return connector.connectorRef === "neon";
    });
    expect(
      neon?.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("returns connected manual grant status from public API-created state", async () => {
    const actor = bdd.user();
    await connectorsApi.connectManualGrant(actor, "openai", "api-token", {
      apiKey: "sk-public-status",
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const openai = response.body.connectors.find((connector) => {
      return connector.connectorRef === "openai";
    });
    expect(openai).toMatchObject({
      connectorRef: "openai",
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
      authMethodSupportsRefresh: false,
      tokenExpiresAt: null,
    });
    expect(openai?.connection).toStrictEqual({
      authMethod: "api-token",
      externalUsername: null,
      externalEmail: null,
      reconnectReason: null,
    });
    expect(openai?.connection).not.toHaveProperty("oauthScopes");
    expect(openai?.connection).not.toHaveProperty("externalId");
    expect(openai?.connection).not.toHaveProperty("createdAt");
    expect(openai?.connection).not.toHaveProperty("updatedAt");
  });

  it("returns connected auth-code status without exposing stored scopes", async () => {
    const actor = bdd.user();
    mockGitHubConnectorOAuth();
    const start = await connectorsApi.startOauth(actor, "github", "oauth");
    await connectorsApi.completeOauthCallback("github", {
      code: `github-${randomUUID()}`,
      state: stateFromAuthorizationUrl(start.authorizationUrl),
    });
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const github = response.body.connectors.find((connector) => {
      return connector.connectorRef === "github";
    });
    expect(github).toMatchObject({
      connectorRef: "github",
      connected: true,
      connectionStatus: "connected",
      scopeMismatch: false,
      singleAuthCodeAuthMethodId: "oauth",
    });
    expect(github?.connection).toMatchObject({
      authMethod: "oauth",
      externalUsername: "bdd-github-user",
    });
    expect(github?.connection).not.toHaveProperty("oauthScopes");
  });

  it("returns scope mismatch status for connectors with missing stored scopes", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorName: "github",
        authMethod: "oauth",
        accessToken: "github-access-token",
        expiresIn: 3600,
      },
      [200],
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const github = response.body.connectors.find((connector) => {
      return connector.connectorRef === "github";
    });
    expect(github).toMatchObject({
      connectorRef: "github",
      connected: true,
      connectionStatus: "scope-mismatch",
      scopeMismatch: true,
      authMethodSupportsRefresh: false,
    });
    expect(github?.connection).toMatchObject({
      authMethod: "oauth",
      reconnectReason: null,
    });
    expect(github?.connection).not.toHaveProperty("oauthScopes");
  });

  it("returns reconnect-required status for expired non-refreshable connectors", async () => {
    const actor = bdd.user();
    await authDevice.provisionTestOrg(actor);
    await authDevice.requestTestConnector(
      { email: actor.email },
      {
        connectorName: "github",
        authMethod: "oauth",
        accessToken: "expired-github-access-token",
        expiresIn: -60,
      },
      [200],
    );
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.status({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const github = response.body.connectors.find((connector) => {
      return connector.connectorRef === "github";
    });
    expect(github).toMatchObject({
      connectorRef: "github",
      connected: true,
      connectionStatus: "reconnect-required",
      scopeMismatch: true,
      authMethodSupportsRefresh: false,
    });
    expect(github?.connection).toMatchObject({
      authMethod: "oauth",
      reconnectReason: "credential_expired",
    });
    expect(github?.tokenExpiresAt).toStrictEqual(expect.any(String));
    expect(Date.parse(github?.tokenExpiresAt ?? "")).toBeLessThan(now());
    expect(github?.connection).not.toHaveProperty("oauthScopes");
  });

  it("returns connector detail without leaking manual field storage names", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "openai" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        placeholder: "sk-...",
        inputType: "password",
      },
    ]);
  });

  it("omits auth text and placeholders derived from private names", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "parallel" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.description).toBeNull();
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "apiKey",
        label: "API Key",
        required: true,
        placeholder: null,
        inputType: "password",
      },
    ]);
  });

  it("returns every visible connector detail without private metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.NeonConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    for (const connector of listResponse.body.connectors) {
      const detailResponse = await accept(
        client.get({
          params: { connectorRef: connector.connectorRef },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      assertPublicConnectorCatalogHasNoPrivateFields(detailResponse.body);
    }
  });

  it("returns 404 for hidden connector catalog refs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "test-oauth-device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "Connector catalog item not found",
    );
  });

  it("rejects connector catalog refs outside the public connector-ref bounds", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const connectorRef = "x".repeat(65);
    const detailResponse = await accept(
      client.get({
        params: { connectorRef },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    const permissionResponse = await accept(
      client.permissions({
        params: { connectorRef },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(detailResponse.body.error.code).toBe("BAD_REQUEST");
    expect(permissionResponse.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns semantic public ids for device-auth start options", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "test-oauth-device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiMethod = response.body.connector.authMethods.find((method) => {
      return method.id === "api";
    });
    expect(apiMethod?.startOptions).toStrictEqual([
      {
        id: "mode",
        kind: "select",
        label: "Mode",
        required: true,
        defaultValue: "test",
        options: [
          { value: "test", label: "Test" },
          { value: "live", label: "Live" },
        ],
      },
    ]);
  });

  it("hides feature-gated auth methods from connector detail", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "neon" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("shows feature-gated auth methods when their connector feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enableConnectorFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.NeonConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "neon" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["oauth", "api-token"]);
  });

  it("returns public permission detail without firewall execution metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.permissions({
        params: { connectorRef: "google-docs" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.permissions.connectorRef).toBe("google-docs");
    expect(response.body.permissions.permissionCount).toBeGreaterThan(0);
    expect(response.body.permissions.permissions).toHaveLength(
      response.body.permissions.permissionCount,
    );
    expect(response.body.permissions.permissions[0]).not.toHaveProperty(
      "rules",
    );
  });
});
