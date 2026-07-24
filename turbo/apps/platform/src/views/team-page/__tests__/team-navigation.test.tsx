import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { loadFirewallPermissionMetadata } from "@vm0/connectors/firewall-metadata";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogPermissionSummary,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroAgentCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-agent-custom-connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowAutomationsContract,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  type ApplyUserPermissionGrantsRequest,
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
  detachedSetupPage as baseDetachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";

const context = testContext();
const zeroAgentId = "c0000000-0000-4000-a000-000000000001";
const researchAgentId = "a0000000-0000-4000-a000-000000000401";
const PAGE_LOAD_TIMEOUT_MS = 5000;

function detachedSetupPage(
  options: Parameters<typeof baseDetachedSetupPage>[0],
): void {
  baseDetachedSetupPage(options);
}

function applyUserConnectorUpdate(
  current: readonly string[],
  body: {
    readonly enabledTypes: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledTypes]));
  }
  if (body.operation === "remove") {
    return current.filter((type) => {
      return !body.enabledTypes.includes(type);
    });
  }
  return [...body.enabledTypes];
}

function applyCustomConnectorUpdate(
  current: readonly string[],
  body: {
    readonly enabledIds: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledIds]));
  }
  if (body.operation === "remove") {
    return current.filter((id) => {
      return !body.enabledIds.includes(id);
    });
  }
  return [...body.enabledIds];
}

function createAgent(id: string, displayName: string): TeamComposeItem {
  return {
    id,
    ownerId: "test-owner-id",
    displayName,
    description: "Finds and summarizes information",
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  };
}

function createWorkflowSummary({
  id,
  agentId,
  agentName,
  agentDisplayName,
  displayName,
  visibility,
}: {
  readonly id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentDisplayName: string;
  readonly displayName: string;
  readonly visibility: "public" | "private";
}): ZeroWorkflowSummary {
  return {
    id,
    agentId,
    agentName,
    agentDisplayName,
    name: displayName.toLowerCase().replace(/\s+/gu, "-"),
    displayName,
    description: "Reusable steps for this agent",
    visibility,
    ownerUserId: "test-owner-id",
    ownerUserDisplayName: "Test User",
    ownerUserImageUrl: null,
    createdAt: "2026-06-20T12:00:00.000Z",
    canManage: true,
    canPublish: true,
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
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function axiomCatalogStatusItem(
  permissionSummary: PublicConnectorCatalogPermissionSummary,
): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: "axiom",
    label: "Axiom",
    description: "Observability and log analytics",
    icon: {
      url: "https://icons.example.test/axiom.svg",
      invertInDarkMode: false,
    },
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "api-token",
        label: "API Token",
        description: null,
        grantKind: "manual",
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary,
    connection: {
      authMethod: "api-token",
      externalUsername: "workspace",
      externalEmail: null,
      reconnectReason: null,
    },
    connected: true,
    connectionStatus: "connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
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
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      {
        key: "secret",
        label: "Secret",
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
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
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

function selectOptionByLabel(
  label: string,
  option: string | RegExp,
  container: HTMLElement,
): void {
  const control =
    within(container)
      .getAllByLabelText(label)
      .find((element) => {
        return element.getAttribute("role") === "combobox";
      }) ?? within(container).getByLabelText(label);
  click(control);
  click(screen.getByRole("option", { name: option }));
}

function buttonByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
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

async function permissionRowByName(
  _container: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  const row = (await screen.findByText(name)).closest("div")?.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${name} permission row not found`);
  }
  return row;
}

async function unknownEndpointsRow(
  _container: HTMLElement,
): Promise<HTMLElement> {
  const row = (await screen.findByText("Other endpoints")).closest(
    "div",
  )?.parentElement;
  if (!(row instanceof HTMLElement)) {
    throw new Error("Other endpoints row not found");
  }
  return row;
}

function dialogForElement(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("dialog not found for element");
  }
  return dialog;
}

function permissionGroupHeader(element: HTMLElement): HTMLElement {
  const header = element.closest("button")?.parentElement;
  if (!(header instanceof HTMLElement)) {
    throw new Error("permission group header not found");
  }
  return header;
}

async function findLoadedPermissionsDialog(): Promise<HTMLElement> {
  const unknownEndpoints = await screen.findByText("Other endpoints");
  return dialogForElement(unknownEndpoints);
}

async function openAxiomPermissionsDialog(): Promise<HTMLElement> {
  mockTeamAPIs();
  detachedSetupPage({
    context,
    path: `/agents/${researchAgentId}`,
  });

  await screen.findByText("@workspace");
  click(screen.getByLabelText("Manage Axiom permissions"));

  const permissionsDialog = await findLoadedPermissionsDialog();
  expect(
    within(permissionsDialog).getByText("for Research Agent"),
  ).toBeInTheDocument();
  return permissionsDialog;
}

async function connectorCategoryLabel(
  connectorType: ConnectorType,
  category: string,
): Promise<string> {
  const metadata = await loadFirewallPermissionMetadata(connectorType);
  const categoryData = metadata?.categories;
  if (!categoryData) {
    throw new Error(`${connectorType} categories not found`);
  }

  const count = Object.values(categoryData.categories).filter((value) => {
    return value === category;
  }).length;
  return `${category} (${count})`;
}

function mockTeamAPIs({
  customConnector = createCustomConnector(),
  onCustomConnectorUpdate,
}: {
  readonly customConnector?: CustomConnectorResponse;
  readonly onCustomConnectorUpdate?: () => void;
} = {}): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.connectors([
    createConnector("github", "octocat"),
    createConnector("axiom", "workspace"),
    createConnector("slack", "ops"),
  ]);
  const enabledTypesByAgent = new Map<string, string[]>();
  const enabledCustomConnectorIdsByAgent = new Map<string, string[]>();
  context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
    return respond(200, {
      enabledTypes: enabledTypesByAgent.get(params.id) ?? [],
    });
  });
  context.mocks.api(
    zeroUserConnectorsContract.update,
    ({ body, params, respond }) => {
      const enabledTypes = applyUserConnectorUpdate(
        enabledTypesByAgent.get(params.id) ?? [],
        body,
      );
      enabledTypesByAgent.set(params.id, enabledTypes);
      return respond(200, { enabledTypes });
    },
  );
  context.mocks.api(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [customConnector] });
  });
  context.mocks.api(
    zeroAgentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        enabledIds: enabledCustomConnectorIdsByAgent.get(params.id) ?? [],
      });
    },
  );
  context.mocks.api(
    zeroAgentCustomConnectorsContract.update,
    ({ body, params, respond }) => {
      onCustomConnectorUpdate?.();
      const enabledCustomConnectorIds = applyCustomConnectorUpdate(
        enabledCustomConnectorIdsByAgent.get(params.id) ?? [],
        body,
      );
      enabledCustomConnectorIdsByAgent.set(
        params.id,
        enabledCustomConnectorIds,
      );
      return respond(200, { enabledIds: enabledCustomConnectorIds });
    },
  );
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, { threadIds: [] });
  });
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const agent = params.id === zeroAgentId ? "Zero" : "Research Agent";
    return respond(200, {
      agentId: params.id,
      ownerId: "test-owner-id",
      displayName: agent,
      description: "Finds and summarizes information",
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

function mockAgentWorkflowApis(): void {
  const workflows = [
    createWorkflowSummary({
      id: "d0000000-0000-4000-a000-000000000701",
      agentId: researchAgentId,
      agentName: "research-runner",
      agentDisplayName: "Research Runner",
      displayName: "Sales Research",
      visibility: "public",
    }),
    createWorkflowSummary({
      id: "d0000000-0000-4000-a000-000000000702",
      agentId: researchAgentId,
      agentName: "research-runner",
      agentDisplayName: "Research Runner",
      displayName: "Ops Playbook",
      visibility: "private",
    }),
    createWorkflowSummary({
      id: "d0000000-0000-4000-a000-000000000703",
      agentId: zeroAgentId,
      agentName: "zero",
      agentDisplayName: "Zero",
      displayName: "Support Intake",
      visibility: "public",
    }),
  ];

  context.mocks.api(
    zeroWorkflowsCollectionContract.list,
    ({ query, respond }) => {
      const visible = query.agentId
        ? workflows.filter((workflow) => {
            return workflow.agentId === query.agentId;
          })
        : workflows;
      return respond(200, visible);
    },
  );
  context.mocks.api(
    zeroWorkflowAutomationsContract.listWorkspace,
    ({ respond }) => {
      return respond(200, []);
    },
  );
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
      expect(pathname()).toBe(`/agents/${researchAgentId}`);
    });
    await screen.findByRole(
      "heading",
      { name: "Research Agent" },
      { timeout: PAGE_LOAD_TIMEOUT_MS },
    );
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

  it("does not allow enabling custom connectors without a secret", async () => {
    let updateCalls = 0;
    mockTeamAPIs({
      customConnector: {
        ...createCustomConnector(),
        connected: false,
        missingRequiredFields: ["secret"],
        configuredFieldKeys: [],
        hasSecret: false,
      },
      onCustomConnectorUpdate: () => {
        updateCalls += 1;
      },
    });

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Acme Search")).toBeInTheDocument();
      expect(screen.getByText(/no secret set/)).toBeInTheDocument();
    });

    const toggle = screen.getByLabelText(
      "Authorize Acme Search for this agent",
    );
    expect(toggle).toBeDisabled();

    fireEvent.click(toggle);
    expect(updateCalls).toBe(0);
    expect(
      screen.queryByText("Custom connectors saved"),
    ).not.toBeInTheDocument();
  });

  it("does not reuse a failed connector authorization draft across agents", async () => {
    mockTeamAPIs();
    let updateCalls = 0;
    context.mocks.api(zeroUserConnectorsContract.update, ({ respond }) => {
      updateCalls += 1;
      return respond(400, {
        error: {
          message: "Connector authorization save failed",
          code: "VALIDATION_ERROR",
        },
      });
    });

    detachedSetupPage({ context, path: `/agents/${researchAgentId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("@octocat")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Grant GitHub access"));
    await waitFor(() => {
      expect(updateCalls).toBe(1);
    });

    context.store.set(detachedNavigateTo$, ROUTES.agentDetail, {
      pathParams: { agentId: zeroAgentId },
      searchParams: new URLSearchParams(),
    });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Zero" })).toBeInTheDocument();
      expect(screen.getByText("@octocat")).toBeInTheDocument();
      expect(screen.getByLabelText("Grant GitHub access")).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Revoke GitHub access"),
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

  it("opens the first chat thread from an agent chat page shortcut", async () => {
    mockTeamAPIs();
    const firstThreadId = "b0000000-0000-4000-a000-000000000601";
    const secondThreadId = "b0000000-0000-4000-a000-000000000602";
    const firstMessageId = "b0000000-0000-4000-a000-000000000501";
    const shortcutThreads = [
      {
        id: firstThreadId,
        title: "First shortcut thread",
        agent: { id: researchAgentId, avatarUrl: null },
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:02:00Z",
        pinnedAt: null,
      },
      {
        id: secondThreadId,
        title: "Second shortcut thread",
        agent: { id: researchAgentId, avatarUrl: null },
        createdAt: "2026-06-01T00:00:00Z",
        updatedAt: "2026-06-01T00:01:00Z",
        pinnedAt: null,
      },
    ];
    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: shortcutThreads.map((thread) => {
          return {
            id: thread.id,
            agentId: thread.agent.id,
            title: thread.title,
            sortAt: thread.updatedAt,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            pinnedAt: thread.pinnedAt,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          };
        }),
        latestEventId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
      return respond(200, { threadIds: [] });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        computerUseHostId: null,
        codexServiceTier: null,
      });
    });
    context.mocks.api(
      chatThreadMessagesContract.list,
      ({ params, query, respond }) => {
        if (query.sinceSeqId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages:
            params.threadId === firstThreadId
              ? [
                  {
                    id: firstMessageId,
                    role: "user",
                    content: "First shortcut thread message",
                    seqId: 1,
                    createdAt: "2026-06-01T00:02:00Z",
                  },
                ]
              : [],
          hasHistoryBefore: false,
        });
      },
    );
    detachedSetupPage({ context, path: `/agents/${researchAgentId}/chat` });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(
          "Ask me to automate workflows, manage tasks...",
        ),
      ).toBeInTheDocument();
    });

    fireEvent.keyDown(
      screen.getByPlaceholderText(
        "Ask me to automate workflows, manage tasks...",
      ),
      {
        key: "ArrowDown",
        ctrlKey: true,
        shiftKey: true,
      },
    );

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${firstThreadId}`);
    });
    await waitFor(() => {
      expect(
        screen.getByText("First shortcut thread message"),
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
    let deleted = false;
    context.mocks.api(zeroAgentsByIdContract.delete, ({ params, respond }) => {
      if (params.id === researchAgentId) {
        deleted = true;
      }
      return respond(204);
    });
    // Once the agent is deleted, any refetch of it must 404 — exactly as
    // production behaves. This guards against reloading the just-deleted agent
    // and surfacing an "Agent not found" error toast over the success toast.
    context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
      if (params.id === researchAgentId && deleted) {
        return respond(404, {
          error: {
            message: `Agent not found: ${researchAgentId}`,
            code: "NOT_FOUND",
          },
        });
      }
      const agent = params.id === zeroAgentId ? "Zero" : "Research Agent";
      return respond(200, {
        agentId: params.id,
        ownerId: "test-owner-id",
        displayName: agent,
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
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
        /Deletes the agent, its workflows, automations, and everyone.s chat history/u,
      ),
    ).toBeInTheDocument();

    click(buttonByText("Delete agent", deleteDialog));

    await waitFor(() => {
      expect(screen.getByText("Agent deleted")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 1, name: /agents/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/Agent not found/u)).not.toBeInTheDocument();
  });

  it("copies a bound workflow onto another agent before deleting the agent", async () => {
    mockTeamAPIs();
    mockAgentWorkflowApis();
    const copyRequests: { workflowId: string; toAgentId: string }[] = [];
    context.mocks.api(
      zeroWorkflowsDetailContract.copy,
      ({ params, body, respond }) => {
        copyRequests.push({
          workflowId: params.workflowId,
          toAgentId: body.toAgentId,
        });
        return respond(
          201,
          createWorkflowSummary({
            id: "d0000000-0000-4000-a000-0000000007ff",
            agentId: zeroAgentId,
            agentName: "zero",
            agentDisplayName: "Zero",
            displayName: "Sales Research",
            visibility: "private",
          }),
        );
      },
    );
    let deleted = false;
    context.mocks.api(zeroAgentsByIdContract.delete, ({ params, respond }) => {
      if (params.id === researchAgentId) {
        deleted = true;
      }
      return respond(204);
    });
    context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
      if (params.id === researchAgentId && deleted) {
        return respond(404, {
          error: {
            message: `Agent not found: ${researchAgentId}`,
            code: "NOT_FOUND",
          },
        });
      }
      const agent = params.id === zeroAgentId ? "Zero" : "Research Agent";
      return respond(200, {
        agentId: params.id,
        ownerId: "test-owner-id",
        displayName: agent,
        description: "Finds and summarizes information",
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      });
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

    // The delete dialog offers to rescue each bound workflow by copying it.
    await waitFor(() => {
      expect(
        within(deleteDialog).getByText("Keep any workflows?"),
      ).toBeInTheDocument();
      expect(
        within(deleteDialog).getByText("Sales Research"),
      ).toBeInTheDocument();
    });

    // Copy "Sales Research" onto Zero; leave "Ops Playbook" to be deleted.
    selectOptionByLabel(
      "Handle workflow Sales Research",
      /Copy to Zero/,
      deleteDialog,
    );

    click(buttonByText("Delete agent", deleteDialog));

    // The workflow is copied first, then the agent is deleted.
    await waitFor(() => {
      expect(copyRequests).toStrictEqual([
        {
          workflowId: "d0000000-0000-4000-a000-000000000701",
          toAgentId: zeroAgentId,
        },
      ]);
    });
    await waitFor(() => {
      expect(deleted).toBeTruthy();
    });
  });

  it("discards connector permission policy drafts when closing the drawer", async () => {
    const permissionsDialog = await openAxiomPermissionsDialog();
    const permissionRow = await permissionRowByName(
      permissionsDialog,
      "annotations|create",
    );
    const loadedPermissionsDialog = dialogForElement(permissionRow);
    click(buttonByText("Allow", permissionRow));
    click(screen.getByLabelText("annotations|create allow options"));
    click(menuItemByText("Allow for 24h"));
    await waitFor(() => {
      expect(within(permissionRow).getByText("24h")).toBeInTheDocument();
      expect(buttonByText("Apply", loadedPermissionsDialog)).toBeEnabled();
    });

    click(buttonByAriaLabel("Close", loadedPermissionsDialog));
    await waitFor(() => {
      expect(screen.queryByText("Axiom permissions")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Axiom permissions"));
    const reopenedPermissionsDialog = await findLoadedPermissionsDialog();
    const reopenedPermissionRow = await permissionRowByName(
      reopenedPermissionsDialog,
      "annotations|create",
    );
    expect(
      within(reopenedPermissionRow).queryByText("24h"),
    ).not.toBeInTheDocument();
    expect(buttonByText("Apply", reopenedPermissionsDialog)).toBeDisabled();
  });

  it("hides connector permission management when catalog status has no permissions", async () => {
    mockTeamAPIs();
    context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
      return respond(200, {
        connectors: [
          axiomCatalogStatusItem({
            hasPermissions: false,
            permissionCount: 0,
            hasCategories: false,
            hasDefaultPolicyOverrides: false,
          }),
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/agents/${researchAgentId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("@workspace")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Manage Axiom permissions"),
    ).not.toBeInTheDocument();
  });

  it("applies and restores connector permission policies from an agent page", async () => {
    const permissionsDialog = await openAxiomPermissionsDialog();
    const permissionRow = await permissionRowByName(
      permissionsDialog,
      "annotations|create",
    );
    const loadedPermissionsDialog = dialogForElement(permissionRow);
    click(buttonByText("Allow", permissionRow));
    click(screen.getByLabelText("annotations|create allow options"));
    click(menuItemByText("Allow for 24h"));
    await waitFor(() => {
      expect(within(permissionRow).getByText("24h")).toBeInTheDocument();
      expect(buttonByText("Apply", loadedPermissionsDialog)).toBeEnabled();
    });
    click(buttonByText("Apply", loadedPermissionsDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(screen.queryByText("Axiom permissions")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Axiom permissions"));

    const resetDialog = dialogForElement(
      await screen.findByText("Axiom permissions"),
    );

    const resetPermissionRow = await permissionRowByName(
      resetDialog,
      "annotations|create",
    );
    const loadedResetDialog = dialogForElement(resetPermissionRow);
    click(buttonByText("Deny", resetPermissionRow));
    click(buttonByText("Deny", await unknownEndpointsRow(loadedResetDialog)));

    await waitFor(() => {
      expect(buttonByText("Restore", loadedResetDialog)).toBeEnabled();
    });
    click(buttonByText("Restore", loadedResetDialog));
    await waitFor(() => {
      expect(buttonByText("Apply", loadedResetDialog)).toBeEnabled();
    });
    click(buttonByText("Apply", loadedResetDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(screen.queryByText("Axiom permissions")).not.toBeInTheDocument();
    });
  });

  it("uses Cloudflare unknown endpoint deny as the permissions drawer default", async () => {
    mockTeamAPIs();
    context.mocks.data.connectors([createConnector("cloudflare", "cf-team")]);
    detachedSetupPage({
      context,
      path: `/agents/${researchAgentId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("@cf-team")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Cloudflare permissions"));

    const permissionsDialog = await findLoadedPermissionsDialog();

    const unknownRow = await unknownEndpointsRow(permissionsDialog);
    const loadedPermissionsDialog = dialogForElement(unknownRow);
    expect(buttonByText("Deny", unknownRow)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(buttonByText("Restore", loadedPermissionsDialog)).toBeDisabled();

    click(buttonByText("Allow", unknownRow));
    await waitFor(() => {
      expect(buttonByText("Allow", unknownRow)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(buttonByText("Restore", loadedPermissionsDialog)).toBeEnabled();
    });

    click(buttonByText("Restore", loadedPermissionsDialog));
    await waitFor(() => {
      expect(buttonByText("Deny", unknownRow)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(buttonByText("Restore", loadedPermissionsDialog)).toBeDisabled();
    });
  });

  it("finds and saves permissions beyond the initial drawer page", async () => {
    mockTeamAPIs();
    context.mocks.data.connectors([createConnector("cloudflare", "cf-team")]);
    const capturedApplies: ApplyUserPermissionGrantsRequest[] = [];
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        capturedApplies.push(body);
        return respond(
          200,
          body.grants.map((grant) => {
            return {
              agentId: body.agentId,
              connectorRef: body.connectorRef,
              permission: grant.permission,
              action: grant.action,
              expiresAt: null,
              createdAt: "2026-03-01T00:00:00.000Z",
              updatedAt: "2026-03-01T00:00:00.000Z",
            };
          }),
        );
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${researchAgentId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Research Agent" }),
      ).toBeInTheDocument();
      expect(screen.getByText("@cf-team")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Manage Cloudflare permissions"));

    const permissionsDialog = await findLoadedPermissionsDialog();
    expect(
      within(permissionsDialog).queryByText("memberships.read"),
    ).not.toBeInTheDocument();

    await fill(
      within(permissionsDialog).getByLabelText("Find permissions"),
      "memberships.read",
    );

    const permissionRow = await permissionRowByName(
      permissionsDialog,
      "memberships.read",
    );
    const loadedPermissionsDialog = dialogForElement(permissionRow);
    click(buttonByText("Deny", permissionRow));
    await waitFor(() => {
      expect(buttonByText("Apply", loadedPermissionsDialog)).toBeEnabled();
    });
    click(buttonByText("Apply", loadedPermissionsDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(capturedApplies).toStrictEqual([
      {
        agentId: researchAgentId,
        connectorRef: "cloudflare",
        mode: "patch",
        grants: [
          {
            permission: "memberships.read",
            action: "deny",
          },
        ],
      },
    ]);
  });

  it("ignores expired allow grants when opening connector permissions", async () => {
    mockNow();
    mockTeamAPIs();
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, [
        {
          agentId: researchAgentId,
          connectorRef: "slack",
          permission: "channels:join",
          action: "allow",
          expiresAt: isoFromNowMs(-60 * 1000),
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ]);
    });

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

    const miscGroupLabel = await connectorCategoryLabel("slack", "Misc");
    const miscGroupElement = await screen.findByText(miscGroupLabel);
    const permissionsDialog = dialogForElement(miscGroupElement);
    click(miscGroupElement);

    const channelsJoinRow = await permissionRowByName(
      permissionsDialog,
      "channels:join",
    );
    expect(buttonByText("Deny", channelsJoinRow)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(buttonByText("Allow", channelsJoinRow)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(buttonByText("Restore", permissionsDialog)).toBeDisabled();
  });

  it("shows aggregate persisted durations on permission category headers", async () => {
    mockNow();
    mockTeamAPIs();
    const metadata = await loadFirewallPermissionMetadata("slack");
    if (!metadata?.categories) {
      throw new Error("slack permission categories not found");
    }
    const categoryByPermission = metadata.categories.categories;
    const permissionNamesInCategory = (category: string): string[] => {
      return metadata.permissions
        .filter((permission) => {
          return categoryByPermission[permission.name] === category;
        })
        .map((permission) => {
          return permission.name;
        });
    };
    const expiresAt = isoFromNowMs(2 * 60 * 60 * 1000);
    const createPersistedGrant = (
      permission: string,
      expiration: string | null,
    ): UserPermissionGrantResponse => {
      return {
        agentId: researchAgentId,
        connectorRef: "slack",
        permission,
        action: "allow",
        expiresAt: expiration,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      };
    };
    const grants = [
      ...permissionNamesInCategory("Read").map((permission) => {
        return createPersistedGrant(permission, expiresAt);
      }),
      ...permissionNamesInCategory("Misc").map((permission, index) => {
        return createPersistedGrant(permission, index === 0 ? null : expiresAt);
      }),
    ];
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });

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

    const readGroupLabel = await connectorCategoryLabel("slack", "Read");
    const readHeader = permissionGroupHeader(
      await screen.findByText(readGroupLabel),
    );
    expect(within(readHeader).getByText("2 hours")).toBeInTheDocument();
    expect(buttonByText("Allow", readHeader)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(readHeader).getByLabelText("Read allow options"),
    ).toBeInTheDocument();

    const miscGroupLabel = await connectorCategoryLabel("slack", "Misc");
    const miscHeader = permissionGroupHeader(
      await screen.findByText(miscGroupLabel),
    );
    expect(within(miscHeader).getByText("Mixed")).toBeInTheDocument();
    expect(buttonByText("Allow", miscHeader)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(miscHeader).queryByLabelText("Misc allow options"),
    ).not.toBeInTheDocument();
  });

  it("saves permission duration changes from an agent page", async () => {
    mockNow();
    mockTeamAPIs();
    const capturedApplies: ApplyUserPermissionGrantsRequest[] = [];
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
      {
        agentId: researchAgentId,
        connectorRef: "axiom",
        permission: "dashboards|read",
        action: "allow",
        expiresAt: isoFromNowMs(2 * 60 * 60 * 1000),
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      {
        agentId: researchAgentId,
        connectorRef: "axiom",
        permission: "datasets|read",
        action: "allow",
        expiresAt: isoFromNowMs(-60 * 1000),
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
      {
        agentId: researchAgentId,
        connectorRef: "axiom",
        permission: "legacy|removed",
        action: "deny",
        expiresAt: null,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      },
    ];
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        capturedApplies.push(body);
        const appliedGrants: UserPermissionGrantResponse[] = body.grants.map(
          (grant) => {
            return {
              agentId: body.agentId,
              connectorRef: body.connectorRef,
              permission: grant.permission,
              action: grant.action,
              expiresAt:
                grant.action === "allow" && grant.expiresIn !== "always"
                  ? isoFromNowMs(60 * 60 * 1000)
                  : null,
              createdAt: "2026-03-01T00:00:00.000Z",
              updatedAt: "2026-03-01T00:30:00.000Z",
            };
          },
        );
        const appliedGrantKeys = new Set(
          appliedGrants.map((grant) => {
            return `${grant.agentId}\u0000${grant.connectorRef}\u0000${grant.permission}`;
          }),
        );
        grants = [
          ...grants.filter((current) => {
            if (
              body.mode === "replace" &&
              current.agentId === body.agentId &&
              current.connectorRef === body.connectorRef
            ) {
              return false;
            }
            return !appliedGrantKeys.has(
              `${current.agentId}\u0000${current.connectorRef}\u0000${current.permission}`,
            );
          }),
          ...appliedGrants,
        ];
        return respond(200, appliedGrants);
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
    const loadedPermissionsDialog = dialogForElement(createRow);
    expect(within(createRow).getByText("< 1 hour")).toBeInTheDocument();

    click(screen.getByLabelText("annotations|create allow options"));
    click(menuItemByText("Allow always"));
    await waitFor(() => {
      expect(within(createRow).getByText("Always")).toBeInTheDocument();
      expect(buttonByText("Apply", loadedPermissionsDialog)).toBeEnabled();
    });

    click(buttonByText("Apply", loadedPermissionsDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
    });
    expect(capturedApplies).toStrictEqual([
      {
        agentId: researchAgentId,
        connectorRef: "axiom",
        mode: "patch",
        grants: [
          {
            permission: "annotations|create",
            action: "allow",
            expiresIn: "always",
          },
        ],
      },
    ]);
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

    const readGroupLabel = await connectorCategoryLabel("slack", "Read");
    const writeGroupLabel = await connectorCategoryLabel("slack", "Write");
    const miscGroupLabel = await connectorCategoryLabel("slack", "Misc");
    const readGroupElement = await screen.findByText(readGroupLabel);
    const loadedGroupedDialog = dialogForElement(readGroupElement);
    expect(
      within(loadedGroupedDialog).getByText("Slack permissions"),
    ).toBeInTheDocument();
    expect(readGroupElement).toBeInTheDocument();
    const readGroupHeader = permissionGroupHeader(readGroupElement);
    const writeGroupElement = await screen.findByText(writeGroupLabel);
    expect(writeGroupElement).toBeInTheDocument();
    const miscGroupElement = await screen.findByText(miscGroupLabel);
    expect(miscGroupElement).toBeInTheDocument();

    expect(within(readGroupHeader).getByText("Mixed")).toBeInTheDocument();
    expect(buttonByText("Allow", readGroupHeader)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      within(readGroupHeader).queryByLabelText("Read allow options"),
    ).not.toBeInTheDocument();

    click(buttonByText("Allow", readGroupHeader));
    await waitFor(() => {
      expect(
        within(readGroupHeader).getByLabelText("Read allow options"),
      ).toHaveTextContent("Always");
    });
    click(within(readGroupHeader).getByLabelText("Read allow options"));
    click(menuItemByText("Allow for 7d"));
    await waitFor(() => {
      expect(
        within(readGroupHeader).getByLabelText("Read allow options"),
      ).toHaveTextContent("7d");
    });
    click(within(readGroupHeader).getByLabelText("Read allow options"));
    click(menuItemByText("Allow always"));
    await waitFor(() => {
      expect(
        within(readGroupHeader).getByLabelText("Read allow options"),
      ).toHaveTextContent("Always");
    });
    click(within(readGroupHeader).getByLabelText("Read allow options"));
    click(menuItemByText("Allow for 7d"));
    await waitFor(() => {
      expect(
        within(readGroupHeader).getByLabelText("Read allow options"),
      ).toHaveTextContent("7d");
    });

    click(readGroupElement);
    const bookmarksReadRow = await permissionRowByName(
      loadedGroupedDialog,
      "bookmarks:read",
    );
    click(
      within(bookmarksReadRow).getByLabelText("bookmarks:read allow options"),
    );
    click(menuItemByText("Allow for 1h"));
    await waitFor(() => {
      expect(within(readGroupHeader).getByText("Mixed")).toBeInTheDocument();
      expect(buttonByText("Allow", readGroupHeader)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        within(readGroupHeader).queryByLabelText("Read allow options"),
      ).not.toBeInTheDocument();
    });

    click(
      within(bookmarksReadRow).getByLabelText("bookmarks:read allow options"),
    );
    click(menuItemByText("Allow for 7d"));
    await waitFor(() => {
      expect(
        within(readGroupHeader).getByLabelText("Read allow options"),
      ).toHaveTextContent("7d");
      expect(within(readGroupHeader).queryByText("Mixed")).toBeNull();
    });

    click(screen.getByText(miscGroupLabel));
    const channelsJoinRow = await permissionRowByName(
      loadedGroupedDialog,
      "channels:join",
    );
    click(buttonByText("Allow", channelsJoinRow));
    click(
      within(channelsJoinRow).getByLabelText("channels:join allow options"),
    );
    click(menuItemByText("Allow for 7d"));
    await waitFor(() => {
      expect(within(channelsJoinRow).getByText("7d")).toBeInTheDocument();
    });
    click(buttonByText("Deny", channelsJoinRow));
    await waitFor(() => {
      expect(within(channelsJoinRow).queryByText("7d")).not.toBeInTheDocument();
    });
    click(buttonByText("Allow", channelsJoinRow));
    click(
      within(channelsJoinRow).getByLabelText("channels:join allow options"),
    );
    click(menuItemByText("Allow always"));
    await waitFor(() => {
      expect(within(channelsJoinRow).getByText("Always")).toBeInTheDocument();
    });

    const permissionsScrollArea =
      loadedGroupedDialog.querySelector(".overflow-y-auto");
    if (!(permissionsScrollArea instanceof HTMLElement)) {
      throw new Error("permissions scroll area not found");
    }
    Object.defineProperty(permissionsScrollArea, "scrollTop", {
      configurable: true,
      value: 24,
    });
    fireEvent.scroll(permissionsScrollArea);

    const unknownRow = await unknownEndpointsRow(loadedGroupedDialog);
    click(buttonByText("Allow", unknownRow));
    click(within(unknownRow).getByLabelText("__unknown__ allow options"));
    click(menuItemByText("Allow for 1h"));
    await waitFor(() => {
      expect(within(unknownRow).getByText("1h")).toBeInTheDocument();
    });

    click(buttonByText("Apply", loadedGroupedDialog));

    await waitFor(() => {
      expect(screen.getByText("Permissions updated")).toBeInTheDocument();
      expect(screen.queryByText("Slack permissions")).not.toBeInTheDocument();
    });
  });
});
