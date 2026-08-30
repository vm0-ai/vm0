import { randomUUID } from "node:crypto";

import type { CreateCustomConnectorBody } from "@okouai/api-contracts/contracts/custom-connectors";
import { mcpConnectorsContract } from "@okouai/api-contracts/contracts/mcp-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import {
  createConnectorBddApi,
  manualHttpCustomConnectorCreateBody,
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
