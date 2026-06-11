import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  type UpsertUserPermissionGrantRequest,
  type UserPermissionGrantResponse,
  zeroUserPermissionGrantsContract,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { createMockScheduleResponse } from "../../../mocks/handlers/schedules-store.ts";
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

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
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

async function permissionRowByName(
  container: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  const row = (await within(container).findByText(name)).closest(
    "div",
  )?.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${name} permission row not found`);
  }
  return row;
}

function unknownEndpointsRow(container: HTMLElement): HTMLElement {
  const row = within(container)
    .getByText("Other endpoints")
    .closest("div")?.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error("Other endpoints row not found");
  }
  return row;
}

function mockTeamAPIs(): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.connectors([
    createConnector("github", "octocat"),
    createConnector("axiom", "workspace"),
    createConnector("slack", "ops"),
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
  it("navigates into an agent and manages connector authorization", async () => {
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
      expect(
        screen.getByLabelText("Authorize Acme Search for this agent"),
      ).toBeChecked();
    });
    toast.dismiss();
    await waitFor(() => {
      expect(
        screen.queryByText("Custom connectors saved"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a retryable error when agent details fail to load", async () => {
    const unavailableAgentId = "bbbbbbbb-0000-4000-a000-000000000500";
    context.mocks.data.team([
      createAgent(unavailableAgentId, "Archived Agent"),
      createAgent(researchAgentId, "Research Agent"),
    ]);
    context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(403, {
        error: {
          message: "Agent details are unavailable",
          code: "AGENT_DETAIL_UNAVAILABLE",
        },
      });
    });

    detachedSetupPage({ context, path: `/agents/${unavailableAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Agent details are unavailable"),
      ).toBeInTheDocument();
    });

    const retry = queryAllByRoleFast("link").find((el) => {
      return el.textContent?.replace(/\s+/g, " ").trim() === "Retry";
    });
    expect(retry).toHaveAttribute("href", `/agents/${unavailableAgentId}`);
  });

  it("shows empty connector guidance from an agent page", async () => {
    mockTeamAPIs();
    context.mocks.data.connectors([]);

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/No connected services yet/u),
      ).toBeInTheDocument();
    });
    const connectorsLink = queryAllByRoleFast("link").find((link) => {
      return link.getAttribute("href") === "/connectors";
    });
    expect(connectorsLink).toBeInTheDocument();
  });

  it("shows a permission grants error from an agent page", async () => {
    mockTeamAPIs();
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(400, {
        error: {
          message: "Permission grants unavailable",
          code: "PERMISSION_GRANTS_UNAVAILABLE",
        },
      });
    });

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Failed to load permission grants"),
      ).toBeInTheDocument();
    });
  });

  it("opens a chat from an agent page", async () => {
    mockTeamAPIs();

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Chat with Research Agent"));

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(
          "Ask me to automate workflows, manage tasks...",
        ),
      ).toBeInTheDocument();
    });
  });

  it("opens avatar customization from an agent page", async () => {
    mockTeamAPIs();

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Customize avatar"));

    const avatarDialog = await screen.findByRole("dialog", {
      name: "Give your agent a face",
    });
    expect(within(avatarDialog).getByText("Angle")).toBeInTheDocument();
  });

  it("deletes an agent from the profile tab", async () => {
    mockTeamAPIs();
    context.mocks.api(zeroAgentsByIdContract.delete, ({ respond }) => {
      return respond(204);
    });

    detachedSetupPage({
      context,
      path: `/agents/${researchAgentId}?tab=profile`,
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Research Agent")).toBeInTheDocument();
    });

    click(screen.getByText("Delete agent"));
    const deleteDialog = await screen.findByRole("dialog");
    expect(
      within(deleteDialog).getByText(
        /instructions, schedules, and all associated data/u,
      ),
    ).toBeInTheDocument();

    click(buttonByText("Delete agent", deleteDialog));

    await waitFor(() => {
      expect(screen.getByText("Agent deleted")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 1, name: /agents/i }),
      ).toBeInTheDocument();
    });
  });

  it("edits and creates schedules from an agent page", async () => {
    mockTeamAPIs();
    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
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
  });

  it("runs an agent schedule and opens its detail page", async () => {
    mockTeamAPIs();
    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
    });
    click(tabByText("Scheduled"));

    await waitFor(() => {
      expect(
        screen.getByText("Research Agent's scheduled tasks"),
      ).toBeInTheDocument();
    });
    expect(screen.getAllByText("Research digest")[0]).toBeInTheDocument();

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
      expect(screen.getAllByText("Research digest")[0]).toBeInTheDocument();
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

  it("updates connector permission policies from an agent page", async () => {
    mockTeamAPIs();
    detachedSetupPage({
      context,
      path: `/agents/${researchAgentId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("@workspace")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Axiom permissions"));

    const permissionsDialog = await screen.findByRole("dialog");
    expect(
      within(permissionsDialog).getByText("Axiom permissions"),
    ).toBeInTheDocument();
    expect(
      within(permissionsDialog).getByText("for Research Agent"),
    ).toBeInTheDocument();

    const permissionRow = await permissionRowByName(
      permissionsDialog,
      "annotations|create",
    );
    click(screen.getByLabelText("annotations|create allow options"));
    click(menuItemByText("Allow for 24h"));
    await waitFor(() => {
      expect(within(permissionRow).getByText("24h")).toBeInTheDocument();
      expect(buttonByText("Apply", permissionsDialog)).toBeEnabled();
    });
    click(buttonByText("Apply", permissionsDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(screen.queryByText("Axiom permissions")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Axiom permissions"));

    const resetDialog = await screen.findByRole("dialog");
    expect(
      within(resetDialog).getByText("Axiom permissions"),
    ).toBeInTheDocument();

    const resetPermissionRow = await permissionRowByName(
      resetDialog,
      "annotations|create",
    );
    click(buttonByText("Deny", resetPermissionRow));
    click(buttonByText("Deny", unknownEndpointsRow(resetDialog)));

    await waitFor(() => {
      expect(buttonByText("Restore", resetDialog)).toBeEnabled();
    });
    click(buttonByText("Restore", resetDialog));
    await waitFor(() => {
      expect(buttonByText("Apply", resetDialog)).toBeEnabled();
    });
    click(buttonByText("Apply", resetDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(screen.queryByText("Axiom permissions")).not.toBeInTheDocument();
    });
  });

  it("saves permission duration changes from an agent page", async () => {
    mockNow();
    mockTeamAPIs();
    const capturedUpserts: UpsertUserPermissionGrantRequest[] = [];
    let grants: UserPermissionGrantResponse[] = [
      {
        agentId: researchAgentId,
        connectorRef: "axiom",
        permission: "annotations|create",
        action: "allow",
        expiresAt: isoFromNowMs(30 * 60 * 1000),
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ];
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.upsert,
      ({ body, respond }) => {
        capturedUpserts.push(body);
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: body.permission,
          action: body.action,
          expiresAt:
            body.action === "allow" && body.expiresIn !== "always"
              ? isoFromNowMs(60 * 60 * 1000)
              : null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:30:00.000Z",
        };
        grants = [
          ...grants.filter((current) => {
            return (
              current.connectorRef !== grant.connectorRef ||
              current.permission !== grant.permission
            );
          }),
          grant,
        ];
        return respond(200, grant);
      },
    );

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("@workspace")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Axiom permissions"));

    const permissionsDialog = await screen.findByRole("dialog");
    const createRow = await permissionRowByName(
      permissionsDialog,
      "annotations|create",
    );
    expect(within(createRow).getByText("< 1 hour")).toBeInTheDocument();

    click(screen.getByLabelText("annotations|create allow options"));
    click(menuItemByText("Allow always"));
    await waitFor(() => {
      expect(within(createRow).getByText("Always")).toBeInTheDocument();
    });

    const deleteRow = await permissionRowByName(
      permissionsDialog,
      "annotations|delete",
    );
    click(screen.getByLabelText("annotations|delete allow options"));
    click(menuItemByText("Allow for 1h"));
    await waitFor(() => {
      expect(within(deleteRow).getByText("1h")).toBeInTheDocument();
    });

    click(buttonByText("Deny", unknownEndpointsRow(permissionsDialog)));
    click(buttonByText("Apply", permissionsDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(capturedUpserts).toStrictEqual(
      expect.arrayContaining([
        {
          agentId: researchAgentId,
          connectorRef: "axiom",
          permission: "annotations|create",
          action: "allow",
          expiresIn: "always",
        },
        {
          agentId: researchAgentId,
          connectorRef: "axiom",
          permission: "annotations|delete",
          action: "allow",
          expiresIn: "1h",
        },
        {
          agentId: researchAgentId,
          connectorRef: "axiom",
          permission: "__unknown__",
          action: "deny",
        },
      ]),
    );
  });

  it("updates grouped connector permission policies from an agent page", async () => {
    mockTeamAPIs();
    detachedSetupPage({
      context,
      path: `/agents/${researchAgentId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("@ops")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Slack permissions"));

    const groupedDialog = await screen.findByRole("dialog");
    expect(
      within(groupedDialog).getByText("Slack permissions"),
    ).toBeInTheDocument();
    expect(within(groupedDialog).getByText("Read (37)")).toBeInTheDocument();
    expect(within(groupedDialog).getByText("Write (23)")).toBeInTheDocument();
    expect(within(groupedDialog).getByText("Misc (5)")).toBeInTheDocument();

    click(screen.getByText("Misc (5)"));
    const miscGroup = screen.getByText("Misc (5)").closest("div");
    if (!(miscGroup instanceof HTMLElement)) {
      throw new Error("Misc permission group not found");
    }
    click(within(miscGroup).getByLabelText("Misc allow options"));
    click(menuItemByText("Allow for 7d"));
    await waitFor(() => {
      expect(within(miscGroup).getByText("7d")).toBeInTheDocument();
    });
    click(buttonByText("Deny", miscGroup));
    await waitFor(() => {
      expect(within(miscGroup).queryByText("7d")).not.toBeInTheDocument();
    });
    click(buttonByText("Allow", miscGroup));
    click(within(miscGroup).getByLabelText("Misc allow options"));
    click(menuItemByText("Allow always"));

    const permissionsScrollArea =
      groupedDialog.querySelector(".overflow-y-auto");
    if (!(permissionsScrollArea instanceof HTMLElement)) {
      throw new Error("permissions scroll area not found");
    }
    Object.defineProperty(permissionsScrollArea, "scrollTop", {
      configurable: true,
      value: 24,
    });
    fireEvent.scroll(permissionsScrollArea);

    const channelsJoinRow = await permissionRowByName(
      groupedDialog,
      "channels:join",
    );
    click(within(channelsJoinRow).getByLabelText("Undo channels:join changes"));
    await waitFor(() => {
      expect(
        within(channelsJoinRow).queryByLabelText("Undo channels:join changes"),
      ).not.toBeInTheDocument();
    });

    const unknownRow = unknownEndpointsRow(groupedDialog);
    click(within(unknownRow).getByLabelText("__unknown__ allow options"));
    click(menuItemByText("Allow for 1h"));
    await waitFor(() => {
      expect(within(unknownRow).getByText("1h")).toBeInTheDocument();
    });
    click(within(unknownRow).getByLabelText("Undo __unknown__ changes"));
    await waitFor(() => {
      expect(within(unknownRow).queryByText("1h")).not.toBeInTheDocument();
    });

    click(buttonByText("Apply", groupedDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(screen.queryByText("Slack permissions")).not.toBeInTheDocument();
    });
  });
});
