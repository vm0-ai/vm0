import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { zeroAddedConnectors$, addZeroConnector$ } from "../zero-connectors.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroAgentsByIdContract } from "@vm0/core/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/core/contracts/user-connectors";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAgentApi(connectors: string[]) {
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user-123",
        description: null,
        displayName: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
      });
    }),
    mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: connectors });
    }),
  );
}

describe("zeroAddedConnectors$", () => {
  it("should seed connectors from user-connectors api", async () => {
    mockAgentApi(["slack", "github"]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    // Server filters out seed skills, only user connectors remain
    expect(connectors).toStrictEqual(["slack", "github"]);
  });

  it("should return empty connectors when agent has none", async () => {
    mockAgentApi([]);

    detachedSetupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    expect(connectors).toStrictEqual([]);
  });

  it("should seed connectors from sub-agent when chat agent is set", async () => {
    // Default agent has slack
    mockAgentApi(["slack"]);

    // Sub-agent has github only
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "sub-agent-compose-id",
          ownerId: "test-user-123",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
      mockApi(zeroUserConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledTypes: ["github"] });
      }),
    );
    // Include cycling-coach in the team list so route setup resolves it
    setMockTeam([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "sub-agent-compose-id",
        displayName: "Cycling Coach",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_2",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    await setupPage({
      context,
      path: "/agents/sub-agent-compose-id/chat",
      withoutRender: true,
    });

    const connectors = await context.store.get(zeroAddedConnectors$);
    // Only sub-agent connectors (server already filters seed skills)
    expect(connectors).toStrictEqual(["github"]);
  });
});

describe("addZeroConnector$", () => {
  it("should add a connector via user-connectors api", async () => {
    let capturedBody: { enabledTypes: string[] } | null = null;

    mockAgentApi(["slack"]);

    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, { enabledTypes: body.enabledTypes });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    // Add connector — saves immediately via user-connectors API
    await context.store.set(addZeroConnector$, "github", context.signal);

    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.enabledTypes).toContain("slack");
    expect(capturedBody!.enabledTypes).toContain("github");
  });

  it("should not fire a PUT when the connector is already enabled", async () => {
    let putCalls = 0;

    mockAgentApi(["slack"]);

    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ body, respond }) => {
        putCalls += 1;
        return respond(200, { enabledTypes: body.enabledTypes });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(addZeroConnector$, "slack", context.signal);

    expect(putCalls).toBe(0);
  });
});
