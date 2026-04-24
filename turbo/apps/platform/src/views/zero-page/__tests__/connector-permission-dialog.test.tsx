/**
 * Tests for the ConnectorPermissionDialog shown after connecting a connector.
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setPermissionDialogType$ } from "../../../signals/zero-page/settings/connectors.ts";
import { permissionDialogSelected$ } from "../../../signals/zero-page/settings/permission-dialog.ts";
import type { ConnectorType } from "@vm0/core/contracts/connectors";
import { zeroUserConnectorsContract } from "@vm0/core/contracts/user-connectors";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockAgents(
  agents: { id: string; displayName: string; avatarUrl?: string }[],
) {
  setMockTeam(
    agents.map((a) => {
      return {
        id: a.id,
        displayName: a.displayName,
        description: null,
        sound: null,
        avatarUrl: a.avatarUrl ?? null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      };
    }),
  );
}

async function openPermissionDialog(connectorType: ConnectorType = "github") {
  detachedSetupPage({ context, path: "/connectors" });

  // Wait for page to render
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connectors" }),
    ).toBeInTheDocument();
  });

  // Trigger the permission dialog via signal
  context.store.set(setPermissionDialogType$, connectorType);
}

describe("connector permission dialog", () => {
  it("renders the dialog with connector label and agent list", async () => {
    mockAgents([
      { id: "agent-1", displayName: "Agent Alpha" },
      { id: "agent-2", displayName: "Agent Beta" },
    ]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(
        screen.getByText(/successfully connected with GitHub/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    expect(screen.getByText("Agent Beta")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search your agents"),
    ).toBeInTheDocument();
    expect(screen.getByText("Later")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
  });

  it("filters agents by search term", async () => {
    const user = userEvent.setup();
    mockAgents([
      { id: "agent-1", displayName: "Agent Alpha" },
      { id: "agent-2", displayName: "Agent Beta" },
      { id: "agent-3", displayName: "Helper Bot" },
    ]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search your agents");
    await user.type(searchInput, "alpha");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });
    expect(screen.queryByText("Agent Beta")).not.toBeInTheDocument();
    expect(screen.queryByText("Helper Bot")).not.toBeInTheDocument();
  });

  it("toggles agent selection on click", async () => {
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    // Click to select — the avatar should be replaced by a check icon
    const agentButton = screen.getAllByRole("button").find((el) => {
      return /Agent Alpha/.test(el.textContent ?? "");
    })!;
    click(agentButton);

    // The check icon (svg) should now be rendered instead of the avatar img
    expect(agentButton.querySelector("svg")).toBeInTheDocument();

    // Click again to deselect — the transparent placeholder span should return
    // (no img: avatarUrl is null, so no default preset flashes)
    click(agentButton);
    expect(agentButton.querySelector("img")).toBeNull();
    expect(agentButton.querySelector("span[aria-hidden]")).toBeInTheDocument();
  });

  it("closes dialog without saving when clicking Later", async () => {
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    let putCalled = false;
    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        putCalled = true;
        return respond(200, { enabledTypes: ["github"] });
      }),
    );

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    // Select an agent
    click(screen.getByText(/Agent Alpha/));

    // Click Later
    click(screen.getByText("Later"));

    // Dialog should close
    await waitFor(() => {
      expect(
        screen.queryByText(/successfully connected with GitHub/),
      ).not.toBeInTheDocument();
    });

    // No API call should have been made
    expect(putCalled).toBeFalsy();
  });

  it("closes dialog without API calls when confirming with no selection", async () => {
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    let putCalled = false;
    server.use(
      mockApi(zeroUserConnectorsContract.update, ({ respond }) => {
        putCalled = true;
        return respond(200, { enabledTypes: ["github"] });
      }),
    );

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    // Confirm without selecting any agent
    click(screen.getByText("Confirm"));

    await waitFor(() => {
      expect(
        screen.queryByText(/successfully connected with GitHub/),
      ).not.toBeInTheDocument();
    });

    expect(putCalled).toBeFalsy();
  });

  it("persists permissions via API when confirming with selected agents", async () => {
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    let updatedAgentId: string | undefined;
    server.use(
      mockApi(
        zeroUserConnectorsContract.update,
        ({ params, body, respond }) => {
          updatedAgentId = params.id;
          return respond(200, { enabledTypes: body.enabledTypes });
        },
      ),
    );

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    // Select the agent
    click(screen.getByText(/Agent Alpha/));

    // Confirm
    click(screen.getByText("Confirm"));

    // Success toast and dialog close
    await waitFor(() => {
      expect(
        screen.getByText("GitHub enabled for 1 agent"),
      ).toBeInTheDocument();
    });

    expect(updatedAgentId).toBe("agent-1");
  });

  it("shows N+ more chip when agent count exceeds visible limit", async () => {
    // Create 18 agents (visible limit is 16)
    const agents = Array.from({ length: 18 }, (_, i) => {
      return {
        id: `agent-${i}`,
        displayName: `Agent ${String(i).padStart(2, "0")}`,
      };
    });
    mockAgents(agents);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent 00")).toBeInTheDocument();
    });

    // Should show the "N+ more" chip
    expect(screen.getByText("2+ more")).toBeInTheDocument();
  });

  it("clears search input and selected agents when dialog is reopened for a new connector", async () => {
    const user = userEvent.setup();
    mockAgents([
      { id: "agent-1", displayName: "Agent Alpha" },
      { id: "agent-2", displayName: "Agent Beta" },
    ]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    // Type a search term to set dialog search state
    const searchInput = screen.getByPlaceholderText("Search your agents");
    await user.type(searchInput, "alpha");

    await waitFor(() => {
      expect(screen.queryByText("Agent Beta")).not.toBeInTheDocument();
    });

    // Select Agent Alpha
    click(screen.getByText("Agent Alpha"));

    // Reopen for a different connector — setPermissionDialogType$ should reset state
    context.store.set(setPermissionDialogType$, "linear");

    // Dialog should still be open (now for linear)
    await waitFor(() => {
      expect(
        screen.getByText(/successfully connected with Linear/),
      ).toBeInTheDocument();
    });

    // Search input should be cleared
    expect(screen.getByPlaceholderText("Search your agents")).toHaveValue("");

    // All agents should be visible again (no search filter)
    expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    expect(screen.getByText("Agent Beta")).toBeInTheDocument();

    // Agent Alpha should no longer be selected — selection set is empty
    expect(context.store.get(permissionDialogSelected$).size).toBe(0);
  });
});
