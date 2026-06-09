import { screen, waitFor, within } from "@testing-library/react";
import type { ConnectorType } from "@vm0/connectors/connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroComposesMainContract } from "@vm0/api-contracts/contracts/zero-composes";
import {
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockScheduleResponse } from "../../../mocks/handlers/api-schedules.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const zeroAgentId = "c0000000-0000-4000-a000-000000000001";
const researchAgentId = "a0000000-0000-4000-a000-000000000401";

function createAgent(id: string, displayName: string): TeamComposeItem {
  return {
    id,
    ownerId: "test-owner-id",
    displayName,
    description: "Finds and summarizes information",
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "public",
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  };
}

function createConnector(
  type: ConnectorType,
  externalUsername: string,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    externalId: `${type}-external-id`,
    externalUsername,
    externalEmail: null,
    oauthScopes: ["read"],
    connectionStatus: "connected",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createCustomConnector(): CustomConnectorResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "acme-search",
    displayName: "Acme Search",
    prefixes: ["https://api.acme.test/v1/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    hasSecret: true,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
  };
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

function mockTeamAPIs(): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.connectors([
    createConnector("github", "octocat"),
    createConnector("axiom", "workspace"),
  ]);
  context.mocks.data.schedules([
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000401",
      agentId: researchAgentId,
      displayName: "Research Agent",
      name: "research-digest-loop",
      triggerType: "loop",
      cronExpression: null,
      intervalSeconds: 1800,
      timezone: "UTC",
      prompt: "Summarize open research requests",
      description: "Research digest",
      enabled: true,
      createdAt: "2026-03-02T00:00:00Z",
      updatedAt: "2026-03-02T00:00:00Z",
    }),
  ]);
  let enabledTypes: string[] = [];
  let enabledCustomConnectorIds: string[] = [];
  const customConnector = createCustomConnector();
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes });
  });
  context.mocks.api(zeroUserConnectorsContract.update, ({ body, respond }) => {
    enabledTypes = body.enabledTypes;
    return respond(200, { enabledTypes });
  });
  context.mocks.api(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [customConnector] });
  });
  context.mocks.api(zeroAgentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledIds: enabledCustomConnectorIds });
  });
  context.mocks.api(
    zeroAgentCustomConnectorsContract.update,
    ({ body, respond }) => {
      enabledCustomConnectorIds = body.enabledIds;
      return respond(200, { enabledIds: enabledCustomConnectorIds });
    },
  );
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(200, {
      pinned: [],
      threads: [],
      hasMore: false,
      nextCursor: null,
      totalCount: 0,
    });
  });
  context.mocks.api(zeroComposesMainContract.getByName, ({ respond }) => {
    return respond(200, {
      id: researchAgentId,
      name: "research-agent",
      headVersionId: "version_2",
      content: {
        version: "1",
        agents: {
          "research-agent": {
            description: "Finds and summarizes information",
            framework: "claude-code",
          },
        },
      },
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
    });
  });
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    return respond(200, {
      agentId: params.id,
      ownerId: "test-owner-id",
      displayName: "Research Agent",
      description: "Finds and summarizes information",
      sound: null,
      avatarUrl: null,
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
    });
  });
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

describe("team page navigation", () => {
  it("navigates into an agent and manages authorization and schedule tabs", async () => {
    mockTeamAPIs();
    detachedSetupPage({ context, path: "/agents" });

    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });

    const agentLink = screen.getByText("Research Agent").closest("a");
    expect(agentLink).not.toBeNull();
    click(agentLink!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("@octocat")).toBeInTheDocument();
      expect(screen.getByText("@workspace")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Find connectors"));
    await fill(screen.getByPlaceholderText("Find connectors..."), "git");

    await waitFor(() => {
      expect(screen.getByText("@octocat")).toBeInTheDocument();
    });
    expect(screen.queryByText("@workspace")).not.toBeInTheDocument();

    click(screen.getByLabelText("Close search"));
    await waitFor(() => {
      expect(screen.getByText("@workspace")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Grant GitHub access"));
    await waitFor(() => {
      expect(screen.getByLabelText("Revoke GitHub access")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Acme Search")).toBeInTheDocument();
      expect(screen.getByText("https://api.acme.test/v1/")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Authorize Acme Search for this agent"));
    await waitFor(() => {
      expect(screen.getByText("Custom connectors saved")).toBeInTheDocument();
    });

    click(tabByText("Scheduled"));

    await waitFor(() => {
      expect(
        screen.getByText("Research Agent's scheduled tasks"),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText("Research digest")[0]).toBeInTheDocument();
    expect(screen.getAllByText(/Every 30 minutes/)[0]).toBeInTheDocument();

    click(screen.getAllByLabelText("More actions for Every 30 minutes")[0]);
    click(menuItemByText("Edit"));

    const editDialog = await screen.findByRole("dialog");
    expect(within(editDialog).getByText("Edit schedule")).toBeInTheDocument();
    await fill(
      within(editDialog).getByDisplayValue("Research digest"),
      "Research digest summary",
    );
    click(buttonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Schedule updated")).toBeInTheDocument();
      expect(
        screen.getAllByText("Research digest summary")[0],
      ).toBeInTheDocument();
    });

    click(buttonByText("Add schedule"));

    const createScheduleDialog = await screen.findByRole("dialog");
    expect(
      within(createScheduleDialog).getByText("Add schedule"),
    ).toBeInTheDocument();
    await fill(
      within(createScheduleDialog).getByLabelText("Prompt"),
      "Collect weekly research links",
    );
    click(buttonByText("Create"));

    await waitFor(() => {
      expect(screen.getByText("Schedule created")).toBeInTheDocument();
      expect(
        screen.getAllByText("Collect weekly research links")[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText("More actions for Every 30 minutes")[0]);
    click(menuItemByText("Run now"));

    await waitFor(() => {
      expect(buttonByText("Add schedule")).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText(
        "Open schedule Summarize open research requests",
      )[0],
    );

    await waitFor(() => {
      expect(
        screen.getAllByText("Research digest summary")[0],
      ).toBeInTheDocument();
    });

    const breadcrumbLink = screen
      .getAllByText("Agents")
      .map((el) => {
        return el.closest("a");
      })
      .find((link) => {
        return link?.getAttribute("href") === "/agents";
      });
    expect(breadcrumbLink).toBeTruthy();

    click(breadcrumbLink!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /agents/i }),
      ).toBeInTheDocument();
    });
  });
});
