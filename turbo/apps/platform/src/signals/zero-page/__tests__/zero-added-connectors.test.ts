import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  zeroAddedConnectors$,
  addZeroConnector$,
  saveZeroConnectors$,
} from "../zero-connectors.ts";
import { setZeroChatAgent$ } from "../zero-nav.ts";

const context = testContext();

function mockAgentApi(connectors: string[]) {
  server.use(
    http.get("*/api/zero/agents/:name", () => {
      return HttpResponse.json({
        name: "test-agent",
        agentComposeId: "mock-compose-id",
        description: null,
        displayName: null,
        sound: null,
        connectors,
      });
    }),
  );
}

describe("zeroAddedConnectors$", () => {
  it("should seed connectors from agent response", async () => {
    mockAgentApi(["slack", "github"]);

    await setupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    // Server filters out seed skills, only user connectors remain
    expect(connectors).toStrictEqual(["slack", "github"]);
  });

  it("should return empty connectors when agent has none", async () => {
    mockAgentApi([]);

    await setupPage({ context, path: "/", withoutRender: true });

    const connectors = await context.store.get(zeroAddedConnectors$);
    expect(connectors).toStrictEqual([]);
  });

  it("should seed connectors from sub-agent when chat agent is set", async () => {
    // Default agent has slack
    mockAgentApi(["slack"]);

    // Sub-agent has github only
    server.use(
      http.get("*/api/zero/agents/cycling-coach", () => {
        return HttpResponse.json({
          name: "cycling-coach",
          agentComposeId: "sub-agent-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: ["github"],
        });
      }),
      // Include cycling-coach in the team list so route setup resolves it
      http.get("*/api/zero/team", () => {
        return HttpResponse.json({
          composes: [
            {
              id: "mock-compose-id",
              name: "zero",
              displayName: null,
              headVersionId: "version_1",
              updatedAt: "2024-01-01T00:00:00Z",
              isOwner: true,
            },
            {
              id: "sub-agent-compose-id",
              name: "cycling-coach",
              displayName: "Cycling Coach",
              headVersionId: "version_2",
              updatedAt: "2024-01-01T00:00:00Z",
              isOwner: false,
            },
          ],
        });
      }),
    );

    await setupPage({
      context,
      path: "/talk/cycling-coach",
      withoutRender: true,
    });
    await context.store.set(setZeroChatAgent$, {
      id: "sub-agent-compose-id",
      name: "cycling-coach",
    });

    const connectors = await context.store.get(zeroAddedConnectors$);
    // Only sub-agent connectors (server already filters seed skills)
    expect(connectors).toStrictEqual(["github"]);
  });
});

describe("addZeroConnector$", () => {
  it("should add a connector locally and save via zero agents api", async () => {
    let capturedBody: { connectors: string[] } | null = null;

    mockAgentApi(["slack"]);

    server.use(
      http.put("*/api/zero/agents/test-agent", async ({ request }) => {
        capturedBody = (await request.json()) as { connectors: string[] };
        return HttpResponse.json({
          name: "test-agent",
          agentComposeId: "mock-compose-id",
          description: null,
          displayName: null,
          sound: null,
          connectors: capturedBody.connectors,
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Add connector locally (deferred save pattern)
    await context.store.set(addZeroConnector$, "github");

    // Local state should include both connectors
    const connectors = await context.store.get(zeroAddedConnectors$);
    expect(connectors).toContain("slack");
    expect(connectors).toContain("github");

    // Save triggers the zero agents API
    await context.store.set(saveZeroConnectors$);

    expect(capturedBody).not.toBeNull();
    // Connectors are sent as short names
    expect(capturedBody!.connectors).toContain("slack");
    expect(capturedBody!.connectors).toContain("github");
  });
});
