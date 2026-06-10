import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  apiKeysByIdContract,
  apiKeysContract,
  type CreateApiKeyResponse,
} from "@vm0/api-contracts/contracts/api-keys";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly userId: string;
  readonly orgId: string;
}

interface CreatedAgent extends Actor {
  readonly agentId: string;
}

interface CreatedConnector extends Actor {
  readonly connectorId: string;
}

interface CreatedApiKey extends Actor {
  readonly keyId: string;
}

type ClerkOrgRole = "org:admin" | "org:member";

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function agentConnectorsClient() {
  return setupApp({ context })(zeroAgentCustomConnectorsContract);
}

function agentsClient() {
  return setupApp({ context })(zeroAgentsMainContract);
}

function agentByIdClient() {
  return setupApp({ context })(zeroAgentsByIdContract);
}

function connectorsClient() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

function connectorByIdClient() {
  return setupApp({ context })(zeroCustomConnectorByIdContract);
}

function apiKeysClient() {
  return setupApp({ context })(apiKeysContract);
}

function apiKeyByIdClient() {
  return setupApp({ context })(apiKeysByIdContract);
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    userId: `user_${prefix}_${suffix}`,
    orgId: `org_${prefix}_${suffix}`,
  };
}

function connectorBody(label: string): CreateCustomConnectorBody {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  return {
    slug,
    displayName: label,
    prefixes: [`https://${slug}.example.com/`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

function mockUserOrganizationMembership(
  member: Actor,
  role: ClerkOrgRole = "org:admin",
): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: member.orgId }, role }],
  });
}

async function createAgent(args: {
  readonly owner: Actor;
  readonly displayName: string;
}): Promise<CreatedAgent> {
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");
  const response = await accept(
    agentsClient().create({
      headers: authHeaders(),
      body: { displayName: args.displayName },
    }),
    [201],
  );

  const agent = { ...args.owner, agentId: response.body.agentId };
  return await trackAgent(Promise.resolve(agent));
}

async function deleteAgent(agent: CreatedAgent): Promise<void> {
  mocks.clerk.session(agent.userId, agent.orgId, "org:admin");
  mocks.s3.listObjects([]);
  await accept(
    agentByIdClient().delete({
      headers: authHeaders(),
      params: { id: agent.agentId },
    }),
    [204, 404],
  );
}

const trackAgent = createFixtureTracker<CreatedAgent>(deleteAgent);

async function createConnector(args: {
  readonly owner: Actor;
  readonly label: string;
}): Promise<CustomConnectorResponse> {
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");
  const response = await accept(
    connectorsClient().create({
      headers: authHeaders(),
      body: connectorBody(args.label),
    }),
    [201],
  );

  await trackConnector(
    Promise.resolve({ ...args.owner, connectorId: response.body.id }),
  );
  return response.body;
}

async function deleteConnector(connector: CreatedConnector): Promise<void> {
  mocks.clerk.session(connector.userId, connector.orgId, "org:admin");
  await accept(
    connectorByIdClient().delete({
      headers: authHeaders(),
      params: { id: connector.connectorId },
    }),
    [204, 404],
  );
}

const trackConnector = createFixtureTracker<CreatedConnector>(deleteConnector);

async function createApiKey(args: {
  readonly owner: Actor;
  readonly name: string;
}): Promise<CreateApiKeyResponse> {
  mocks.clerk.session(args.owner.userId, args.owner.orgId, "org:admin");
  const response = await accept(
    apiKeysClient().create({
      headers: authHeaders(),
      body: { name: args.name, expiresInDays: 30 },
    }),
    [201],
  );

  await trackApiKey(
    Promise.resolve({ ...args.owner, keyId: response.body.id }),
  );
  return response.body;
}

async function deleteApiKey(apiKey: CreatedApiKey): Promise<void> {
  mocks.clerk.session(apiKey.userId, apiKey.orgId, "org:admin");
  await accept(
    apiKeyByIdClient().delete({
      headers: authHeaders(),
      params: { id: apiKey.keyId },
    }),
    [204, 404],
  );
}

const trackApiKey = createFixtureTracker<CreatedApiKey>(deleteApiKey);

async function readEnabledIds(args: {
  readonly viewer: Actor;
  readonly agentId: string;
}): Promise<readonly string[]> {
  mocks.clerk.session(args.viewer.userId, args.viewer.orgId, "org:admin");
  const response = await accept(
    agentConnectorsClient().get({
      headers: authHeaders(),
      params: { id: args.agentId },
    }),
    [200],
  );
  return response.body.enabledIds;
}

async function expectEnabledIds(args: {
  readonly viewer: Actor;
  readonly agentId: string;
  readonly enabledIds: readonly string[];
}): Promise<void> {
  const actual = await readEnabledIds({
    viewer: args.viewer,
    agentId: args.agentId,
  });
  expect(new Set(actual)).toStrictEqual(new Set(args.enabledIds));
}

function sandboxHeadersWithoutAgentRead(): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "zero",
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    capabilities: ["file:read"],
    iat: seconds,
    exp: seconds + 60,
  });
  return bearerHeaders(token);
}

describe("/api/zero/agents/:id/custom-connectors BDD", () => {
  it("requires authentication, an active organization, and sandbox agent:read capability", async () => {
    const client = agentConnectorsClient();
    const agentId = randomUUID();

    const unauthenticatedGet = await accept(
      client.get({ params: { id: agentId }, headers: {} }),
      [401],
    );
    const unauthenticatedUpdate = await accept(
      client.update({
        params: { id: agentId },
        headers: {},
        body: { enabledIds: [] },
      }),
      [401],
    );

    expect(unauthenticatedGet.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedUpdate.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgGet = await accept(
      client.get({ params: { id: agentId }, headers: authHeaders() }),
      [401],
    );
    const noOrgUpdate = await accept(
      client.update({
        params: { id: agentId },
        headers: authHeaders(),
        body: { enabledIds: [] },
      }),
      [401],
    );

    expect(noOrgGet.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(noOrgUpdate.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    const sandboxWithoutCapability = await accept(
      client.get({
        params: { id: agentId },
        headers: sandboxHeadersWithoutAgentRead(),
      }),
      [403],
    );

    expect(sandboxWithoutCapability.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns an empty list for a new agent and accepts an owner API key", async () => {
    const owner = actor("zacc_owner");
    const agent = await createAgent({
      owner,
      displayName: "custom-connector-agent",
    });

    await expectEnabledIds({
      viewer: owner,
      agentId: agent.agentId,
      enabledIds: [],
    });

    const apiKey = await createApiKey({
      owner,
      name: "custom connector route",
    });
    mockUserOrganizationMembership(owner);

    const response = await accept(
      agentConnectorsClient().get({
        params: { id: agent.agentId },
        headers: bearerHeaders(apiKey.token),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledIds: [] });
  });

  it("replaces and clears enabled custom connectors through API read-after-write", async () => {
    const owner = actor("zacc_roundtrip");
    const agent = await createAgent({
      owner,
      displayName: "roundtrip-agent",
    });
    const first = await createConnector({ owner, label: "round-a" });
    const second = await createConnector({ owner, label: "round-b" });
    const client = agentConnectorsClient();

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const enabledBoth = await accept(
      client.update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { enabledIds: [first.id, second.id] },
      }),
      [200],
    );

    expect(new Set(enabledBoth.body.enabledIds)).toStrictEqual(
      new Set([first.id, second.id]),
    );
    await expectEnabledIds({
      viewer: owner,
      agentId: agent.agentId,
      enabledIds: [first.id, second.id],
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const replaced = await accept(
      client.update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { enabledIds: [second.id] },
      }),
      [200],
    );

    expect(replaced.body.enabledIds).toStrictEqual([second.id]);
    await expectEnabledIds({
      viewer: owner,
      agentId: agent.agentId,
      enabledIds: [second.id],
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const cleared = await accept(
      client.update({
        params: { id: agent.agentId },
        headers: authHeaders(),
        body: { enabledIds: [] },
      }),
      [200],
    );

    expect(cleared.body.enabledIds).toStrictEqual([]);
    await expectEnabledIds({
      viewer: owner,
      agentId: agent.agentId,
      enabledIds: [],
    });
  });

  it("returns not found for missing or cross-org agents and rejects cross-org connector ids", async () => {
    const owner = actor("zacc_owner_org");
    const other = actor("zacc_other_org");
    const ownerAgent = await createAgent({
      owner,
      displayName: "owner-agent",
    });
    const otherAgent = await createAgent({
      owner: other,
      displayName: "other-agent",
    });
    const otherConnector = await createConnector({
      owner: other,
      label: "other-connector",
    });
    const unknownAgentId = randomUUID();
    const client = agentConnectorsClient();

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const missingGet = await accept(
      client.get({
        params: { id: unknownAgentId },
        headers: authHeaders(),
      }),
      [404],
    );
    const missingUpdate = await accept(
      client.update({
        params: { id: unknownAgentId },
        headers: authHeaders(),
        body: { enabledIds: [] },
      }),
      [404],
    );
    const crossOrgAgent = await accept(
      client.get({
        params: { id: otherAgent.agentId },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missingGet.body).toStrictEqual({
      error: {
        message: `Agent not found: ${unknownAgentId}`,
        code: "NOT_FOUND",
      },
    });
    expect(missingUpdate.body).toStrictEqual({
      error: {
        message: `Agent not found: ${unknownAgentId}`,
        code: "NOT_FOUND",
      },
    });
    expect(crossOrgAgent.body).toStrictEqual({
      error: {
        message: `Agent not found: ${otherAgent.agentId}`,
        code: "NOT_FOUND",
      },
    });

    mocks.clerk.session(owner.userId, owner.orgId, "org:admin");
    const crossOrgConnector = await accept(
      client.update({
        params: { id: ownerAgent.agentId },
        headers: authHeaders(),
        body: { enabledIds: [otherConnector.id] },
      }),
      [400],
    );

    expect(crossOrgConnector.body).toStrictEqual({
      error: {
        message: `Unknown custom connector ids: ${otherConnector.id}`,
        code: "VALIDATION_ERROR",
      },
    });
    await expectEnabledIds({
      viewer: owner,
      agentId: ownerAgent.agentId,
      enabledIds: [],
    });
  });
});
