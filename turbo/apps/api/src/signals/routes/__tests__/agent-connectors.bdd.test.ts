import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for enabling org custom connectors on a zero agent.
// Preconditions (agent + custom connectors) and assertions are built entirely
// from real HTTP requests. See `api.bdd.md` (CHAIN-CONNECTOR) for the plan and
// the legacy cases this replaces.
const context = testContext();

function connectorBody(displayName: string, host: string) {
  return {
    displayName,
    prefixes: [`https://${host}.example.com`],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

describe("agent custom connectors (API-first BDD)", () => {
  it("chain-connector: enables, reads, replaces, then clears custom connectors", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    api.actAsAdmin();

    // Given an agent and two org custom connectors, all created via the API.
    const agent = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Connector Agent" },
      }),
      [201],
    );
    const agentId = agent.body.agentId;
    const c1 = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("Connector One", "one"),
      }),
      [201],
    );
    const c2 = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("Connector Two", "two"),
      }),
      [201],
    );

    // Then the agent starts with no enabled connectors.
    const initial = await accept(
      api.agentCustomConnectors.get({
        params: { id: agentId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(initial.body.enabledIds).toStrictEqual([]);

    // When both connectors are enabled. Then they round-trip through GET.
    const enabled = await accept(
      api.agentCustomConnectors.update({
        params: { id: agentId },
        headers: SESSION_AUTH,
        body: { enabledIds: [c1.body.id, c2.body.id] },
      }),
      [200],
    );
    expect(new Set(enabled.body.enabledIds)).toStrictEqual(
      new Set([c1.body.id, c2.body.id]),
    );
    const afterEnable = await accept(
      api.agentCustomConnectors.get({
        params: { id: agentId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(new Set(afterEnable.body.enabledIds)).toStrictEqual(
      new Set([c1.body.id, c2.body.id]),
    );

    // When the set is replaced with just one. Then the replace is atomic.
    await accept(
      api.agentCustomConnectors.update({
        params: { id: agentId },
        headers: SESSION_AUTH,
        body: { enabledIds: [c1.body.id] },
      }),
      [200],
    );
    const afterReplace = await accept(
      api.agentCustomConnectors.get({
        params: { id: agentId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(afterReplace.body.enabledIds).toStrictEqual([c1.body.id]);

    // When cleared with an empty array. Then none remain.
    await accept(
      api.agentCustomConnectors.update({
        params: { id: agentId },
        headers: SESSION_AUTH,
        body: { enabledIds: [] },
      }),
      [200],
    );
    const afterClear = await accept(
      api.agentCustomConnectors.get({
        params: { id: agentId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(afterClear.body.enabledIds).toStrictEqual([]);
  });

  it("rejects a custom connector that belongs to another org", async () => {
    const api = createBddApi(context);
    api.allowInstructionsStorage();
    const owner = api.actAsAdmin();

    const agent = await accept(
      api.agents.create({
        headers: SESSION_AUTH,
        body: { displayName: "Owner Agent" },
      }),
      [201],
    );
    const agentId = agent.body.agentId;

    // Given a custom connector created by a different org.
    api.actAsAdmin();
    const foreign = await accept(
      api.customConnectors.create({
        headers: SESSION_AUTH,
        body: connectorBody("Foreign", "foreign"),
      }),
      [201],
    );

    // When the owner tries to enable it. Then it is rejected and nothing sticks.
    api.actAsAdmin({ userId: owner.userId, orgId: owner.orgId });
    const rejected = await accept(
      api.agentCustomConnectors.update({
        params: { id: agentId },
        headers: SESSION_AUTH,
        body: { enabledIds: [foreign.body.id] },
      }),
      [400],
    );
    expect(rejected.body.error).toStrictEqual({
      message: `Unknown custom connector ids: ${foreign.body.id}`,
      code: "VALIDATION_ERROR",
    });
    const still = await accept(
      api.agentCustomConnectors.get({
        params: { id: agentId },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(still.body.enabledIds).toStrictEqual([]);
  });

  describe("authorization", () => {
    it("rejects unauthenticated and no-organization requests", async () => {
      const api = createBddApi(context);
      const id = randomUUID();

      await accept(
        api.agentCustomConnectors.get({ params: { id }, headers: {} }),
        [401],
      );
      await accept(
        api.agentCustomConnectors.update({
          params: { id },
          headers: {},
          body: { enabledIds: [] },
        }),
        [401],
      );

      api.actAsNoOrg();
      await accept(
        api.agentCustomConnectors.get({
          params: { id },
          headers: SESSION_AUTH,
        }),
        [401],
      );
      await accept(
        api.agentCustomConnectors.update({
          params: { id },
          headers: SESSION_AUTH,
          body: { enabledIds: [] },
        }),
        [401],
      );
    });

    it("rejects unknown agents and zero tokens missing agent:read", async () => {
      const api = createBddApi(context);
      api.actAsAdmin();
      const unknownId = randomUUID();

      const getMissing = await accept(
        api.agentCustomConnectors.get({
          params: { id: unknownId },
          headers: SESSION_AUTH,
        }),
        [404],
      );
      expect(getMissing.body.error.message).toBe(
        `Agent not found: ${unknownId}`,
      );
      const putMissing = await accept(
        api.agentCustomConnectors.update({
          params: { id: unknownId },
          headers: SESSION_AUTH,
          body: { enabledIds: [] },
        }),
        [404],
      );
      expect(putMissing.body.error.message).toBe(
        `Agent not found: ${unknownId}`,
      );

      const capability = await accept(
        api.agentCustomConnectors.get({
          params: { id: randomUUID() },
          headers: api.zeroAuth(["file:read"]),
        }),
        [403],
      );
      expect(capability.body.error.message).toBe(
        "Missing required capability: agent:read",
      );
    });
  });
});
