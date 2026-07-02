import { randomUUID } from "node:crypto";

import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { mockClerkMembership } from "./helpers/api-bdd-clerk";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsAutomationsApi(context);
const connectors = createConnectorBddApi(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function agentCustomConnectorsClient() {
  return setupApp({ context })(zeroAgentCustomConnectorsContract);
}

function bearerHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function createAgent(
  actor: ApiTestUser,
  body: Parameters<typeof bdd.createAgent>[1] = {},
) {
  bdd.acceptAgentStorageWrites();
  return await bdd.createAgent(actor, body);
}

async function apiKeyHeaders(
  actor: ApiTestUser,
): Promise<{ readonly authorization: string }> {
  const key = await api.createApiKey(actor);
  mockClerkMembership(context, actor, actor.orgRole ?? "org:admin");
  return bearerHeaders(key.token);
}

function zeroTokenFor(
  actor: ApiTestUser,
  capabilities: readonly ZeroCapability[],
): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId: actor.userId,
    orgId: actor.orgId,
    runId: randomUUID(),
    capabilities,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function createUnconfiguredCustomConnector(
  actor: ApiTestUser,
  slug: string,
) {
  return await connectors.createCustomConnector(actor, {
    displayName: `Connector ${slug}`,
    slug,
    prefixes: [`https://${slug}.example.test`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  });
}

async function createCustomConnector(actor: ApiTestUser, slug: string) {
  const connector = await createUnconfiguredCustomConnector(actor, slug);
  await connectors.setCustomConnectorSecret(
    actor,
    connector.id,
    `${slug}-secret`,
  );
  return connector;
}

describe("GET /api/zero/agents/:id/custom-connectors", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await connectors.requestAgentCustomConnectors(
      null,
      randomUUID(),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await connectors.requestAgentCustomConnectors(
      actor,
      randomUUID(),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty enabledIds for an agent with no enabled custom connectors", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });

    const response = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );

    expect(response).toStrictEqual([]);
  });

  it("accepts an API key for the agent owner", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "API Key Agent" });

    const response = await accept(
      agentCustomConnectorsClient().get({
        params: { id: agent.agentId },
        headers: await apiKeyHeaders(actor),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ enabledIds: [] });
  });

  it("returns 404 for a non-existent agent", async () => {
    const actor = bdd.user();
    const unknownId = randomUUID();

    const response = await connectors.requestAgentCustomConnectors(
      actor,
      unknownId,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the agent belongs to a different org without leaking existence", async () => {
    const owner = bdd.user();
    const requester = bdd.user();
    const agent = await createAgent(owner, { displayName: "Other Agent" });

    const response = await connectors.requestAgentCustomConnectors(
      requester,
      agent.agentId,
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 403 for a zero token without agent:read capability", async () => {
    const actor = bdd.user();
    const token = zeroTokenFor(actor, ["file:read"]);

    const response = await accept(
      agentCustomConnectorsClient().get({
        params: { id: randomUUID() },
        headers: bearerHeaders(token),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent:read",
        code: "FORBIDDEN",
      },
    });
  });
});

describe("PUT /api/zero/agents/:id/custom-connectors", () => {
  it("returns 401 when the request is unauthenticated", async () => {
    const response = await connectors.requestUpdateAgentCustomConnectors(
      null,
      randomUUID(),
      [],
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const actor = bdd.user({ orgId: null });
    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      randomUUID(),
      [],
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 for a non-existent agent", async () => {
    const actor = bdd.user();
    const unknownId = randomUUID();

    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      unknownId,
      [],
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: `Agent not found: ${unknownId}`, code: "NOT_FOUND" },
    });
  });

  it("sets enabled ids and round-trips through the API", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const c1 = await createCustomConnector(actor, "round-a");
    const c2 = await createCustomConnector(actor, "round-b");

    const response = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [c1.id, c2.id],
    );

    expect(new Set(response)).toStrictEqual(new Set([c1.id, c2.id]));
    const readBack = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect([...readBack].sort()).toStrictEqual([...response].sort());
  });

  it("rejects enabling custom connectors without required user values", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const connector = await createUnconfiguredCustomConnector(
      actor,
      "missing-secret",
    );

    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      agent.agentId,
      [connector.id],
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Custom connector ids are not configured for this user: ${connector.id}`,
        code: "VALIDATION_ERROR",
      },
    });
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });

  it("returns agent not found before connector configuration errors", async () => {
    const owner = bdd.user();
    const requester = bdd.user({ orgId: owner.orgId });
    const agent = await createAgent(owner, {
      displayName: "Private Agent",
      visibility: "private",
    });
    const connector = await createUnconfiguredCustomConnector(
      requester,
      "hidden-agent-order",
    );

    const response = await connectors.requestUpdateAgentCustomConnectors(
      requester,
      agent.agentId,
      [connector.id],
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Agent not found: ${agent.agentId}`,
        code: "NOT_FOUND",
      },
    });
  });

  it("replaces the list atomically", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const c1 = await createCustomConnector(actor, "rep-1");
    const c2 = await createCustomConnector(actor, "rep-2");

    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [c1.id]);
    const replaced = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [c2.id],
    );

    expect(replaced).toStrictEqual([c2.id]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([c2.id]);
  });

  it("serializes concurrent custom connector replaces for the same agent", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Concurrent Agent" });
    const c1 = await createCustomConnector(actor, "conc-1");
    const c2 = await createCustomConnector(actor, "conc-2");

    const sameSetUpdates = await Promise.all([
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [
        c1.id,
        c2.id,
      ]),
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [
        c1.id,
        c2.id,
      ]),
    ]);
    for (const update of sameSetUpdates) {
      expect(new Set(update)).toStrictEqual(new Set([c1.id, c2.id]));
    }

    await Promise.all([
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [c1.id]),
      connectors.updateAgentCustomConnectors(actor, agent.agentId, [c2.id]),
    ]);
    const readBack = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect(readBack).toHaveLength(1);
    expect([c1.id, c2.id]).toContain(readBack[0]);

    await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [],
      "replace",
    );
    await Promise.all([
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c1.id],
        "add",
      ),
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c2.id],
        "add",
      ),
    ]);
    const readAfterAdds = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect(new Set(readAfterAdds)).toStrictEqual(new Set([c1.id, c2.id]));

    await Promise.all([
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c1.id],
        "remove",
      ),
      connectors.updateAgentCustomConnectors(
        actor,
        agent.agentId,
        [c2.id],
        "add",
      ),
    ]);
    const readAfterRemoveAdd = await connectors.readAgentCustomConnectors(
      actor,
      agent.agentId,
    );
    expect(readAfterRemoveAdd).toStrictEqual([c2.id]);
  });

  it("clears authorizations with empty array", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const connector = await createCustomConnector(actor, "clr-1");

    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    const cleared = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [],
    );

    expect(cleared).toStrictEqual([]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });

  it("allows removing an enabled custom connector after its secret is deleted", async () => {
    const actor = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const connector = await createCustomConnector(actor, "remove-unconfigured");

    await connectors.updateAgentCustomConnectors(actor, agent.agentId, [
      connector.id,
    ]);
    await connectors.deleteCustomConnectorSecret(actor, connector.id);

    const updated = await connectors.updateAgentCustomConnectors(
      actor,
      agent.agentId,
      [connector.id],
      "remove",
    );

    expect(updated).toStrictEqual([]);
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });

  it("returns 400 for a cross-org custom connector id", async () => {
    const actor = bdd.user();
    const other = bdd.user();
    const agent = await createAgent(actor, { displayName: "Test Agent" });
    const otherConnector = await createCustomConnector(other, "other-org");

    const response = await connectors.requestUpdateAgentCustomConnectors(
      actor,
      agent.agentId,
      [otherConnector.id],
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: `Unknown custom connector ids: ${otherConnector.id}`,
        code: "VALIDATION_ERROR",
      },
    });
    await expect(
      connectors.readAgentCustomConnectors(actor, agent.agentId),
    ).resolves.toStrictEqual([]);
  });
});
