import { randomUUID } from "node:crypto";

import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
  mockAutomaticMcpOAuthProvider,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";
import { mcpConnectorsRoutes } from "../mcp-connectors";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const runs = createRunsApi(context);
const mocks = createRouteMocks(context);

type McpCreateBody = Extract<
  CreateCustomConnectorBody,
  { readonly kind: "mcp" }
>;

function manualMcpConnectorBody(args: {
  readonly slug: string;
  readonly displayName: string;
  readonly endpoint: string;
}): McpCreateBody {
  return {
    kind: "mcp",
    slug: args.slug,
    displayName: args.displayName,
    endpoint: args.endpoint,
    transport: "streamable-http",
    fields: [
      {
        key: "secret",
        label: "API token",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
  };
}

function client() {
  return setupApp({ context, routes: mcpConnectorsRoutes })(
    mcpConnectorsContract,
  );
}

function headers(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createRunForAgent(actor: ApiTestUser, agentId: string) {
  return await runs.createDirectRun(actor, {
    agentId,
    prompt: "Discover MCP connectors",
    modelProviderType: "anthropic-api-key",
    vars: { OKOU_AGENT_ID: agentId },
    secrets: { OKOU_TOKEN: "mcp-discovery-okou-token" },
  });
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected connector authorization URL to include state");
  }
  return state;
}

describe("GET /api/mcp-connectors", () => {
  it("returns only the current Agent's MCP grants", async () => {
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP Discovery Agent",
    });
    const otherAgent = await bdd.createAgent(actor, {
      displayName: "Other Agent",
    });
    const run = await createRunForAgent(actor, agent.agentId);

    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const disconnected = await connectors.createCustomConnector(
      actor,
      manualMcpConnectorBody({
        slug: "_alpha-mcp",
        displayName: "Alpha MCP",
        endpoint: "https://alpha-mcp.example.test/server",
      }),
    );
    const connected = await connectors.createCustomConnector(
      actor,
      manualMcpConnectorBody({
        slug: "_zulu-mcp",
        displayName: "Zulu MCP",
        endpoint: "https://zulu-mcp.example.test/server",
      }),
    );
    await connectors.setCustomConnectorSecret(
      actor,
      connected.id,
      "zulu-secret",
    );
    const ungranted = await connectors.createCustomConnector(
      actor,
      manualMcpConnectorBody({
        slug: "_ungranted-mcp",
        displayName: "Ungranted MCP",
        endpoint: "https://ungranted-mcp.example.test/server",
      }),
    );
    const otherAgentConnector = await connectors.createCustomConnector(
      actor,
      manualMcpConnectorBody({
        slug: "_other-agent-mcp",
        displayName: "Other Agent MCP",
        endpoint: "https://other-agent-mcp.example.test/server",
      }),
    );
    const httpConnector = await connectors.createCustomConnector(
      actor,
      manualHttpCustomConnectorCreateBody({
        slug: "_http-connector",
        displayName: "HTTP Connector",
        prefixTemplates: ["https://http-connector.example.test/v1/"],
      }),
    );
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      disconnected.id,
      connected.id,
      httpConnector.id,
    ]);
    await connectors.updateAgentCustomConnectors(actor, otherAgent.agentId, [
      otherAgentConnector.id,
    ]);
    mockClerkMembership(context, actor, "org:admin");

    const response = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, run.runId, [
            "connector:read",
          ]),
        ),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      connectors: [
        {
          id: disconnected.id,
          slug: "_alpha-mcp",
          displayName: "Alpha MCP",
          transport: "streamable-http",
          endpoint: "https://alpha-mcp.example.test/server",
          connected: false,
        },
        {
          id: connected.id,
          slug: "_zulu-mcp",
          displayName: "Zulu MCP",
          transport: "streamable-http",
          endpoint: "https://zulu-mcp.example.test/server",
          connected: true,
        },
      ],
    });
    expect(response.body.connectors).not.toContainEqual(
      expect.objectContaining({ id: ungranted.id }),
    );
    const peer = bdd.user({ orgId: actor.orgId });
    const peerResponse = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(peer, run.runId, [
            "connector:read",
          ]),
        ),
      }),
      [200],
    );
    const foreign = bdd.user();
    mockClerkMembership(context, foreign, "org:admin");
    const foreignResponse = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(foreign, run.runId, [
            "connector:read",
          ]),
        ),
      }),
      [200],
    );

    expect(peerResponse.body).toStrictEqual({ connectors: [] });
    expect(foreignResponse.body).toStrictEqual({ connectors: [] });
  });

  it("returns an empty authoritative result when the token run is absent", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");

    const response = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, randomUUID(), [
            "connector:read",
          ]),
        ),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ connectors: [] });
  });

  it("requires agent authentication with connector read capability", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");
    const runId = randomUUID();

    const unauthenticated = await accept(client().list({ headers: {} }), [401]);
    const missingCapability = await accept(
      client().list({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, []),
        ),
      }),
      [403],
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const session = await accept(
      client().list({ headers: headers("clerk-session") }),
      [403],
    );

    expect(unauthenticated.status).toBe(401);
    expect(missingCapability.status).toBe(403);
    expect(session.status).toBe(403);
  });
});

describe("POST /api/mcp-connectors/:id/oauth2/reauthorize", () => {
  it.each(["cimd", "dcr"] as const)(
    "reauthorizes the exact Automatic OAuth account pinned to the run with %s",
    async (registration) => {
      bdd.acceptAgentStorageWrites();
      runs.acceptStorageDownloads();
      runs.acceptTelemetryIngest();
      const runnerGroup = runs.configureRunnerGroup();
      mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
      mockEnv("OKOU_WEB_URL", "https://www.vm0.ai");
      mockEnv("APP_URL", "https://app.vm0.ai");
      const provider = mockAutomaticMcpOAuthProvider(context, {
        registration,
        initialExpiresIn: 3600,
        authorizationCodeScopes: ["read", "read", "read admin"],
      });
      const actor = bdd.user({ orgRole: "org:admin" });
      await runs.grantProEntitlement(actor);
      await runs.ensureOrgModelProvider(actor);
      const agent = await bdd.createAgent(actor, {
        displayName: "MCP scope reauthorization Agent",
      });
      await connectors.updateFeatureSwitches(actor, {
        [FeatureSwitchKey.CustomConnectorMcp]: true,
        [FeatureSwitchKey.ConnectorAccounts]: true,
      });
      const connector = await connectors.createCustomConnector(actor, {
        kind: "mcp",
        displayName: "MCP scope reauthorization",
        endpoint: provider.endpoint,
        transport: "streamable-http",
        fields: [],
        headerInjections: [],
        queryInjections: [],
        authMode: "automatic",
      });
      const firstAuthorization = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        undefined,
        { intent: "add", displayName: "Pinned account" },
      );
      await connectors.completeCustomConnectorOAuth2Callback({
        code: "pinned-account-code",
        state: stateFromAuthorizationUrl(firstAuthorization),
        iss: provider.issuer,
      });
      const secondAuthorization = await connectors.startCustomConnectorOAuth2(
        actor,
        connector.id,
        undefined,
        { intent: "add", displayName: "Sibling account" },
      );
      await connectors.completeCustomConnectorOAuth2Callback({
        code: "sibling-account-code",
        state: stateFromAuthorizationUrl(secondAuthorization),
        iss: provider.issuer,
      });
      const initialAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      const pinnedAccount = initialAccounts.find((account) => {
        return account.isDefault;
      });
      const siblingAccount = initialAccounts.find((account) => {
        return !account.isDefault;
      });
      if (!pinnedAccount || !siblingAccount) {
        throw new Error("Expected default and sibling MCP accounts");
      }
      await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
        connector.id,
      ]);
      const run = await runs.createRun(
        actor,
        {
          agentId: agent.agentId,
          prompt: "Use the MCP connector with incremental scope",
          modelProvider: "anthropic-api-key",
        },
        "okou",
      );
      expect(run.status).toBe("pending");
      await runs.heartbeatRunner(runnerGroup);
      const claim = await runs.claimRunnerJob(run.runId);
      const okouToken = claim.platformEnvironment.OKOU_TOKEN;
      if (!okouToken) {
        throw new Error("Expected the claimed run to include an Okou token");
      }
      const registrationCount = provider.registrationBodies.length;
      provider.advertiseAuthorizationServers([
        "https://alternate-issuer.example.test",
        provider.issuer,
      ]);

      const response = await accept(
        client().reauthorizeOAuth({
          headers: headers(okouToken),
          params: { id: connector.id },
          body: { scopes: ["admin"] },
        }),
        [200],
      );

      const authorizationUrl = new URL(response.body.authorizationUrl);
      expect(authorizationUrl.searchParams.get("scope")).toBe("read admin");
      expect(response.body.expiresAt).toStrictEqual(expect.any(String));
      expect(provider.registrationBodies).toHaveLength(registrationCount);
      await connectors.completeCustomConnectorOAuth2Callback({
        code: "scope-upgrade-code",
        state: stateFromAuthorizationUrl(response.body.authorizationUrl),
        iss: provider.issuer,
      });
      const upgradedAccounts = await connectors.listCustomConnectorAccounts(
        actor,
        connector.id,
      );
      expect(
        upgradedAccounts.find((account) => {
          return account.id === pinnedAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read", "admin"]);
      expect(
        upgradedAccounts.find((account) => {
          return account.id === siblingAccount.id;
        })?.oauthScopes,
      ).toStrictEqual(["read"]);
      provider.advertiseAuthorizationServers([
        "https://alternate-issuer.example.test",
      ]);
      const removedIssuer = await accept(
        client().reauthorizeOAuth({
          headers: headers(okouToken),
          params: { id: connector.id },
          body: { scopes: ["owner"] },
        }),
        [409],
      );
      expect(removedIssuer.body.error.code).toBe("CONFLICT");
      await runs.requestCancelRun(actor, run.runId, [200]);
    },
  );

  it("rejects Automatic accounts resolved to no authentication", async () => {
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const runnerGroup = runs.configureRunnerGroup();
    mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
    mockEnv("OKOU_WEB_URL", "https://www.vm0.ai");
    mockEnv("APP_URL", "https://app.vm0.ai");
    mockAutomaticMcpOAuthProvider(context, {
      registration: "cimd",
      authentication: "none",
    });
    const actor = bdd.user({ orgRole: "org:admin" });
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "MCP no-auth reauthorization Agent",
    });
    await connectors.updateFeatureSwitches(actor, {
      [FeatureSwitchKey.CustomConnectorMcp]: true,
    });
    const connector = await connectors.createCustomConnector(actor, {
      kind: "mcp",
      displayName: "MCP no-auth reauthorization",
      endpoint: "https://automatic-mcp.example.test/server",
      transport: "streamable-http",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
    });
    const connected = await connectors.requestStartCustomConnectorOAuth2(
      actor,
      connector.id,
      [200],
      agent.agentId,
    );
    if ("error" in connected.body || connected.body.result !== "connected") {
      throw new Error("Expected Automatic MCP no-auth connection");
    }
    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    const run = await runs.createRun(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Use the no-auth MCP connector",
        modelProvider: "anthropic-api-key",
      },
      "okou",
    );
    expect(run.status).toBe("pending");
    await runs.heartbeatRunner(runnerGroup);
    const claim = await runs.claimRunnerJob(run.runId);
    const okouToken = claim.platformEnvironment.OKOU_TOKEN;
    if (!okouToken) {
      throw new Error("Expected the claimed run to include an Okou token");
    }

    const response = await accept(
      client().reauthorizeOAuth({
        headers: headers(okouToken),
        params: { id: connector.id },
        body: { scopes: ["admin"] },
      }),
      [409],
    );

    expect(response.body.error.code).toBe("CONFLICT");
    await runs.requestCancelRun(actor, run.runId, [200]);
  });

  it("requires agent authentication with connector write capability", async () => {
    const actor = bdd.user();
    mockClerkMembership(context, actor, "org:admin");
    const runId = randomUUID();
    const connectorId = randomUUID();

    const unauthenticated = await accept(
      client().reauthorizeOAuth({
        headers: {},
        params: { id: connectorId },
        body: { scopes: ["admin"] },
      }),
      [401],
    );
    const missingCapability = await accept(
      client().reauthorizeOAuth({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, []),
        ),
        params: { id: connectorId },
        body: { scopes: ["admin"] },
      }),
      [403],
    );
    mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
    const session = await accept(
      client().reauthorizeOAuth({
        headers: headers("clerk-session"),
        params: { id: connectorId },
        body: { scopes: ["admin"] },
      }),
      [403],
    );
    const unpinned = await accept(
      client().reauthorizeOAuth({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, [
            "connector:write",
          ]),
        ),
        params: { id: connectorId },
        body: { scopes: ["admin"] },
      }),
      [409],
    );
    const malformedScope = await accept(
      client().reauthorizeOAuth({
        headers: headers(
          runs.okouTokenForRunWithCapabilities(actor, runId, [
            "connector:write",
          ]),
        ),
        params: { id: connectorId },
        body: { scopes: ["invalid scope"] },
      }),
      [400],
    );

    expect(unauthenticated.status).toBe(401);
    expect(missingCapability.status).toBe(403);
    expect(session.status).toBe(403);
    expect(unpinned.body.error.code).toBe("CONFLICT");
    expect(malformedScope.body.error.code).toBe("BAD_REQUEST");
  });
});
