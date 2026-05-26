import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";

const context = testContext();
const mockApi = createMockApi(context);

describe("jobCustomConnectorsSection", () => {
  function mockAPIs() {
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
        id: "agent-detail-id",
        displayName: "My Agent",
        description: "A helpful agent",
        sound: null,
        avatarUrl: null,
        headVersionId: "version_2",
        updatedAt: "2024-01-02T00:00:00Z",
      },
    ]);
    setMockConnectors([]);
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: "e0000000-0000-4000-a000-000000000010",
          ownerId: "test-owner-id",
          description: "A helpful agent",
          displayName: "My Agent",
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        });
      }),
      mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
        return respond(200, { content: null, filename: null });
      }),
      mockApi(zeroAgentCustomConnectorsContract.get, ({ respond }) => {
        return respond(200, { enabledIds: [] });
      }),
    );
  }

  it("renders the agent detail page with correct heading", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/agents/my-agent" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Agent" }),
      ).toBeInTheDocument();
    });

    // Verify the Authorization tab is visible (the tab where custom connectors section lives)
    expect(
      queryAllByRoleFast("tab").find((el) => {
        return /Authorization/.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();
  });
});
