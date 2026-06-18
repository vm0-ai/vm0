import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  CONNECTOR_TYPE_KEYS,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  r2ImageTransformUrl,
  type PresentationTemplateItem,
} from "@vm0/core";
import {
  chatThreadByIdContract,
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroWorkflowsCollectionContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  PLACEHOLDER,
  sendMessageInUI,
} from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "e0000000-0000-4000-a000-000000000010";
const OTHER_AGENT_ID = "e0000000-0000-4000-a000-000000000011";
const THREAD_ID = "thread-model-template-1";
const ANTHROPIC_PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const MOONSHOT_PROVIDER_ID = "00000000-0000-4000-a000-000000000002";
const ZAI_PROVIDER_ID = "00000000-0000-4000-a000-000000000003";
const NOW = "2026-05-08T00:00:00.000Z";

function connectorSearchFixtureTypes(): readonly ConnectorType[] {
  const excludes = new Set<ConnectorType>([
    "github",
    "gmail",
    "notion",
    "slack",
  ]);
  return CONNECTOR_TYPE_KEYS.filter((type) => {
    return !excludes.has(type);
  }).slice(0, 21);
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

function linkByText(text: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

function mockNavigatorUserAgent(userAgent: string): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
  return () => {
    if (original) {
      Object.defineProperty(navigator, "userAgent", original);
    } else {
      delete (navigator as { userAgent?: string }).userAgent;
    }
  };
}

function buildProvider(
  overrides: Partial<ModelProviderResponse> & {
    id: string;
    type: ModelProviderResponse["type"];
  },
): ModelProviderResponse {
  return {
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
    authMethod: null,
    secretNames: null,
    isDefault: false,
    selectedModel: null,
    needsReconnect: false,
    lastRefreshErrorCode: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function buildModelPolicy(
  overrides: Partial<OrgModelPolicy> & Pick<OrgModelPolicy, "model">,
): OrgModelPolicy {
  return {
    id: "00000000-0000-4000-a000-000000000101",
    modelLabel: "Claude Opus 4.7",
    isDefault: false,
    defaultProviderType: "claude-code-oauth-token",
    credentialScope: "member",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mockOrgModelRoutes(defaultSelectedModel: string): void {
  context.mocks.data.orgModelProviders([
    buildProvider({
      id: MOONSHOT_PROVIDER_ID,
      type: "moonshot-api-key",
      secretName: "MOONSHOT_API_KEY",
    }),
    buildProvider({
      id: ANTHROPIC_PROVIDER_ID,
      type: "anthropic-api-key",
      secretName: "ANTHROPIC_API_KEY",
    }),
    buildProvider({
      id: ZAI_PROVIDER_ID,
      type: "zai-api-key",
      secretName: "ZAI_API_KEY",
    }),
  ]);
  context.mocks.data.orgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000201",
      model: "kimi-k2.7-code",
      modelLabel: "Kimi K2.7 Code",
      isDefault: defaultSelectedModel === "kimi-k2.7-code",
      defaultProviderType: "moonshot-api-key",
      credentialScope: "org",
      modelProviderId: MOONSHOT_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000202",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: defaultSelectedModel === "claude-sonnet-4-6",
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: ANTHROPIC_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000203",
      model: "claude-opus-4-7",
      modelLabel: "Claude Opus 4.7",
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: ANTHROPIC_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000204",
      model: "glm-5.1",
      modelLabel: "GLM-5.1",
      isDefault: defaultSelectedModel === "glm-5.1",
      defaultProviderType: "zai-api-key",
      credentialScope: "org",
      modelProviderId: ZAI_PROVIDER_ID,
    }),
  ]);
}

function mockAgent(options?: {
  selectedModel?: string | null;
  modelProviderId?: string | null;
}): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      displayName: "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: options?.modelProviderId ?? null,
      selectedModel: options?.selectedModel ?? null,
      preferPersonalProvider: false,
    });
  });
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

function mockThread(options?: {
  selectedModel?: string | null;
  activeRunIds?: string[];
  messages?: PagedChatMessage[];
}): void {
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      id: THREAD_ID,
      title: "My thread",
      agentId: AGENT_ID,
      activeRunIds: options?.activeRunIds ?? [],
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      draftContent: null,
      draftAttachments: null,
      modelProviderId: null,
      selectedModel: options?.selectedModel ?? null,
    });
  });
  context.mocks.api(chatThreadMessagesContract.list, ({ respond }) => {
    return respond(200, { messages: options?.messages ?? [] });
  });
}

function mockActiveTemplateThread(): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatMessages: [
      {
        id: "msg-template-active-user",
        role: "user",
        content: "Start an active deck run",
        runId: "run-template-active",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: "msg-template-active-assistant",
        role: "assistant",
        content: null,
        runId: "run-template-active",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
    activeRunIds: ["run-template-active"],
  });
}

function mockConnectors(
  connectors: {
    type: ConnectorType;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    oauthScopes?: string[];
  }[],
): void {
  context.mocks.data.connectors(
    connectors.map((connector): ConnectorResponse => {
      return {
        id: crypto.randomUUID(),
        type: connector.type,
        authMethod: connector.authMethod ?? "oauth",
        externalId: null,
        externalUsername: connector.externalUsername ?? null,
        externalEmail: null,
        oauthScopes: connector.oauthScopes ?? null,
        connectionStatus: "connected",
        reconnectReason: null,
        tokenExpiresAt: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}

function mockManyConnectedConnectors(): void {
  mockConnectors([
    { type: "github", externalUsername: "octocat" },
    { type: "slack", externalUsername: "launch-team" },
    ...connectorSearchFixtureTypes().map((type) => {
      return { type };
    }),
  ]);
}

function mockAgentConnectorAuthorizations(initialTypes: string[]): void {
  let enabledTypes = initialTypes;
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes });
  });
  context.mocks.api(zeroUserConnectorsContract.update, ({ body, respond }) => {
    enabledTypes = body.enabledTypes;
    return respond(200, { enabledTypes });
  });
}

function resetPresentationTemplateHtmlPreviewCache(): void {
  Reflect.deleteProperty(globalThis, "vm0PresentationTemplateHtmlPreviewCache");
}

async function expectComposerModel(label: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: label })).toBeInTheDocument();
  });
}

async function openTemplatePicker(
  user: ReturnType<typeof userEvent.setup>,
  template: PresentationTemplateItem = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!,
): Promise<void> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  await fill(screen.getByLabelText("Search templates"), "no matching deck");
  await waitFor(() => {
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  await fill(screen.getByLabelText("Search templates"), template.title);
  await waitFor(() => {
    expect(screen.getByText(template.title)).toBeInTheDocument();
  });

  click(screen.getByLabelText(`View template ${template.title}`));
  await waitFor(() => {
    expect(
      screen.getByTestId(`${template.title} detail HTML preview`),
    ).toBeInTheDocument();
  });
  expect(screen.getByLabelText("Select style Carnival")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Select style Gold Luxe")).toBeInTheDocument();

  await user.click(screen.getByLabelText(`Select template ${template.title}`));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

async function selectTemplate(
  user: ReturnType<typeof userEvent.setup>,
  template: PresentationTemplateItem,
): Promise<void> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  await user.click(screen.getByLabelText(`Select template ${template.title}`));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

async function selectIllustrationTemplate(
  user: ReturnType<typeof userEvent.setup>,
  template: (typeof ILLUSTRATION_TEMPLATE_ITEMS)[number],
): Promise<void> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  await user.click(tabByText("Illustration"));
  await user.click(screen.getByLabelText(`Select template ${template.title}`));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

function chatClipboardHtml(payload: {
  text: string;
  attachments: {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
}): string {
  return `<div data-vm0-chat-message="${encodeURIComponent(
    JSON.stringify(payload),
  )}"></div>`;
}

function oversizedFile(name: string, type: string): File {
  const file = new File(["oversized"], name, { type });
  Object.defineProperty(file, "size", {
    configurable: true,
    value: 1024 * 1024 * 1024 + 1,
  });
  return file;
}

function composerElementFrom(textarea: HTMLElement): HTMLElement {
  const composer = textarea.closest(".zero-composer");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Composer element not found");
  }
  return composer;
}

// The slash-workflow composer renders a TipTap contenteditable instead of a
// textarea, so locate it directly rather than by placeholder.
async function findComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

function placeCaretAfterText(root: HTMLElement, text: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const content = node.textContent ?? "";
    const index = content.indexOf(text);
    if (index === -1) {
      continue;
    }

    const range = document.createRange();
    range.setStart(node, index + text.length);
    range.collapse(true);
    root.focus();
    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Selection API is not available");
    }
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return;
  }
  throw new Error(`${text} text node not found`);
}

function workflowSummary({
  name,
  displayName,
  description,
  attachedAgentIds = [],
}: {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly attachedAgentIds?: readonly string[];
}) {
  return {
    name,
    displayName,
    description,
    visibility: "public" as const,
    ownerUserId: "user-1",
    attachedAgentCount: attachedAgentIds.length,
    attachedAgents: attachedAgentIds.map((agentId) => {
      return {
        agentId,
        ownerId: "test-user-123",
        displayName: agentId === AGENT_ID ? "Scout" : "Other Agent",
        description: null,
        avatarUrl: null,
        visibility: "public" as const,
      };
    }),
    canManage: true,
  };
}

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  resetPresentationTemplateHtmlPreviewCache();
});

describe("chat composer models", () => {
  it("suggests current agent workflows from slash input and highlights inserted workflow tokens", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "sales-research",
          displayName: "Sales Research",
          description: "Find account context before outreach",
          attachedAgentIds: [AGENT_ID],
        }),
        workflowSummary({
          name: "support-escalation",
          displayName: "Support Escalation",
          description: "Summarize customer issues for handoff",
          attachedAgentIds: [AGENT_ID],
        }),
        workflowSummary({
          name: "deep-dive",
          displayName: "Deep Dive",
          description: "Seeded org workflow",
        }),
        workflowSummary({
          name: "other-agent-workflow",
          displayName: "Other Agent Workflow",
          description: "Attached somewhere else",
          attachedAgentIds: [OTHER_AGENT_ID],
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ChatSlashWorkflowCommands]: true },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    const salesSuggestion = await screen.findByText("/sales-research");
    expect(salesSuggestion).toBeInTheDocument();
    expect(screen.getByText("/support-escalation")).toBeInTheDocument();
    expect(screen.queryByText("/deep-dive")).not.toBeInTheDocument();
    expect(screen.queryByText("/other-agent-workflow")).not.toBeInTheDocument();
    // The menu renders in a Radix Popover portal (Floating UI handles
    // cross-browser placement), so it lives outside the composer element.
    const slashWorkflowMenu = screen.getByTestId("slash-workflow-menu");
    expect(slashWorkflowMenu).toBeInTheDocument();

    await user.keyboard("sales");

    await waitFor(() => {
      expect(screen.queryByText("/support-escalation")).not.toBeInTheDocument();
    });
    expect(screen.getByText("/sales-research")).toBeInTheDocument();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(editor.textContent).toContain("/sales-research");
    });
    // The colored token is a real inline decoration in the same layer as the
    // text (no overlay), so it stays aligned when the composer scrolls.
    const highlightedWorkflow = screen
      .getAllByText("/sales-research")
      .find((element) => {
        return element.tagName.toLowerCase() === "span";
      });
    expect(highlightedWorkflow).toHaveClass("text-primary");
  });

  it("does not suggest workflows that are not attached to the current agent", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "deep-dive",
          displayName: "Deep Dive",
          description: "Seeded org workflow",
        }),
        workflowSummary({
          name: "other-agent-workflow",
          displayName: "Other Agent Workflow",
          description: null,
          attachedAgentIds: [OTHER_AGENT_ID],
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ChatSlashWorkflowCommands]: true },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    await waitFor(() => {
      expect(screen.queryByText("/deep-dive")).not.toBeInTheDocument();
    });
    expect(editor.textContent).toContain("/");
  });

  it("links to the workflows page from the slash workflow menu footer", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "deep-dive",
          displayName: "Deep Dive",
          description: "Seeded org workflow",
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ChatSlashWorkflowCommands]: true,
        [FeatureSwitchKey.WorkflowsViewer]: true,
      },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");

    await expect(
      screen.findByText("No matching workflows"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("/deep-dive")).not.toBeInTheDocument();
    const link = linkByText("View all workflows");
    expect(link).toHaveAttribute("href", "/workflows");
    expect(link.parentElement).toHaveClass("shrink-0", "border-t");
  });

  it("hides slash workflow suggestions when the feature switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [
        workflowSummary({
          name: "sales-research",
          displayName: "Sales Research",
          description: null,
          attachedAgentIds: [AGENT_ID],
        }),
      ]);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ChatSlashWorkflowCommands]: false },
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(textarea);
    await user.keyboard("/");

    expect(screen.queryByText("/sales-research")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("/");
  });

  it("scrolls the slash workflow picker with keyboard selection", async () => {
    const user = userEvent.setup({ delay: null });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    mockOrgModelRoutes("kimi-k2.7-code");
    const customWorkflows = Array.from({ length: 12 }, (_, index) => {
      return `custom-workflow-${index + 1}`;
    });
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(
        200,
        customWorkflows.map((name) => {
          return workflowSummary({
            name,
            displayName: null,
            description: null,
            attachedAgentIds: [AGENT_ID],
          });
        }),
      );
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ChatSlashWorkflowCommands]: true },
    });

    const editor = await findComposerEditor();
    await user.click(editor);
    await user.keyboard("/");
    await expect(
      screen.findByText("/custom-workflow-1"),
    ).resolves.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    });
  });

  it("keeps Shift+Enter and Mac Ctrl+A/Ctrl+E scoped to composer lines", async () => {
    const restoreUserAgent = mockNavigatorUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    );
    try {
      const user = userEvent.setup({ delay: null });
      mockOrgModelRoutes("kimi-k2.7-code");
      mockAgent();
      context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
        return respond(200, []);
      });

      detachedSetupPage({
        context,
        path: `/agents/${AGENT_ID}/chat`,
        featureSwitches: { [FeatureSwitchKey.ChatSlashWorkflowCommands]: true },
      });

      const editor = await findComposerEditor();
      await user.click(editor);
      await user.keyboard("first line{Shift>}{Enter}{/Shift}second line");
      await user.keyboard("{Control>}a{/Control}X");

      await waitFor(() => {
        expect(editor.innerHTML).toContain(
          "<p>first line</p><p>Xsecond line</p>",
        );
        expect(editor.innerHTML).not.toContain("<br>");
      });

      placeCaretAfterText(editor, "Xsecond line");
      await user.keyboard("{Shift>}{Enter}{/Shift}third line");
      placeCaretAfterText(editor, "Xsecond line");
      await user.keyboard("{Control>}e{/Control}Y");

      await waitFor(() => {
        expect(editor.innerHTML).toContain(
          "<p>first line</p><p>Xsecond lineY</p><p>third line</p>",
        );
        expect(editor.innerHTML).not.toContain("<br>");
      });
    } finally {
      restoreUserAgent();
    }
  });

  it("resolves workspace, user, and thread model choices in the visible picker", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Kimi K2.7 Code");
  });

  it("shows user preference over workspace default", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Claude Opus 4.7");
  });

  it("shows thread override over user and workspace defaults, then remains editable", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("kimi-k2.7-code");
    context.mocks.data.userModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent();
    mockThread({
      selectedModel: "glm-5.1",
      messages: [
        {
          id: "msg-user",
          role: "user",
          content: "Use GLM",
          createdAt: "2026-03-10T00:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expectComposerModel("GLM-5.1");
    await user.click(screen.getByRole("combobox", { name: "GLM-5.1" }));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );
    await expectComposerModel("Claude Sonnet 4.6");
  });

  it("opens the model picker directly to options and labels BYOK routes", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.data.orgModelProviders([]);
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000301",
        model: "claude-sonnet-4-6",
        modelLabel: "Claude Sonnet 4.6",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000302",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        defaultProviderType: "moonshot-api-key",
        credentialScope: "org",
        modelProviderId: MOONSHOT_PROVIDER_ID,
      }),
    ]);
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await user.click(
      await screen.findByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: /Kimi K2\.7 Code BYOK/ }),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Use workspace default model")).toBeNull();
    });
  });

  it("blocks routed model sends until the matching device login is opened", async () => {
    const user = userEvent.setup({ delay: null });
    const codexApproval = context.mocks.deferred<void>();
    const codexProvider = buildProvider({
      id: "00000000-0000-4000-a000-000000000402",
      type: "codex-oauth-token",
      framework: "codex",
      secretName: null,
      authMethod: "auth_json",
      secretNames: ["CODEX_AUTH_JSON"],
    });
    context.mocks.browser.open(context.mocks.browser.authWindow());
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT-5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([]);
    mockAgent();
    context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-codex-device-session",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://auth.openai.com/codex/device",
        verificationCode: "ABCD-EFGH",
        expiresIn: 30,
        interval: 1,
      });
    });
    context.mocks.api(
      zeroCodexDeviceAuthContract.complete,
      async ({ respond }) => {
        await codexApproval.promise;
        context.mocks.data.personalModelProviders([codexProvider]);
        return respond(200, {
          status: "complete",
          provider: codexProvider,
          created: true,
        });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectComposerModel("GPT-5.5");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      /Model Configure: This workspace routes GPT-5\.5/,
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("ABCD-EFGH");
    expect(screen.getByText("Connect Codex")).toBeInTheDocument();

    click(screen.getByTestId("codex-device-auth-open"));

    await expect(
      screen.findByText("Device code copied. Waiting for approval..."),
    ).resolves.toBeInTheDocument();
    codexApproval.resolve(undefined);
    await waitFor(() => {
      expect(screen.getByText("ChatGPT connected")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Connect Codex")).not.toBeInTheDocument();
    });
  });

  it("opens reconnect login for a stale personal Codex routed model", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.open(null);
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT-5.5",
        isDefault: true,
        defaultProviderType: "codex-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([
      buildProvider({
        id: "00000000-0000-4000-a000-000000000403",
        type: "codex-oauth-token",
        framework: "codex",
        secretName: null,
        authMethod: "auth_json",
        secretNames: ["CODEX_AUTH_JSON"],
        needsReconnect: true,
        lastRefreshErrorCode: "refresh_token_expired",
      }),
    ]);
    mockAgent();
    context.mocks.api(zeroCodexDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-stale-codex-device-session",
        type: "codex",
        status: "pending",
        scope: "personal",
        browserUrl: "https://auth.openai.com/codex/device",
        verificationCode: "RECO-NNECT",
        expiresIn: 30,
        interval: 1,
      });
    });
    context.mocks.api(zeroCodexDeviceAuthContract.complete, ({ respond }) => {
      return respond(200, { status: "pending", errorMessage: null });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectComposerModel("GPT-5.5");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      /Model Configure: ChatGPT \(Codex\) needs to be reconnected before you can use GPT-5\.5/u,
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("RECO-NNECT");
    expect(screen.getByText("Re-connect Codex")).toBeInTheDocument();
  });

  it("completes personal Claude Code auth from a routed model blocker", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.browser.open(null);
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        model: "claude-opus-4-7",
        modelLabel: "Claude Opus 4.7",
        isDefault: true,
        defaultProviderType: "claude-code-oauth-token",
        credentialScope: "member",
      }),
    ]);
    context.mocks.data.personalModelProviders([]);
    mockAgent();
    context.mocks.api(zeroClaudeCodeDeviceAuthContract.start, ({ respond }) => {
      return respond(200, {
        sessionToken: "mock-claude-code-device-session",
        type: "claude-code",
        status: "pending",
        scope: "personal",
        browserUrl: "https://claude.ai/oauth/authorize",
        expiresIn: 30,
      });
    });
    context.mocks.api(
      zeroClaudeCodeDeviceAuthContract.complete,
      ({ respond }) => {
        return respond(200, {
          status: "complete",
          provider: buildProvider({
            id: "00000000-0000-4000-a000-000000000401",
            type: "claude-code-oauth-token",
            secretName: "CLAUDE_CODE_OAUTH_TOKEN",
          }),
          created: true,
        });
      },
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectComposerModel("Claude Opus 4.7");

    await fill(await screen.findByPlaceholderText(PLACEHOLDER), "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      /Model Configure: This workspace routes Claude Opus 4\.7/u,
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("claude-code-device-auth-code"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Connect Claude Code")).toBeInTheDocument();

    click(screen.getByTestId("claude-code-device-auth-submit"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Paste the Claude Code authorization code to continue.",
    );

    click(screen.getByTestId("claude-code-device-auth-open"));
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "The approval page could not be opened.",
    );

    await fill(
      screen.getByTestId("claude-code-device-auth-code"),
      "mock-claude-code",
    );
    click(screen.getByTestId("claude-code-device-auth-submit"));

    await waitFor(() => {
      expect(screen.getByText("Claude Code connected")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText("Connect Claude Code")).not.toBeInTheDocument();
    });
  });

  it("keeps unsupported visual files out of text-only model sends while accepting text files", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("glm-5.1");
    mockAgent();
    context.mocks.upload.success({
      id: "notes-upload",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://example.com/notes.txt",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("GLM-5.1");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;

    await user.upload(
      fileInput,
      new File(["image"], "screenshot.png", { type: "image/png" }),
    );

    await expect(
      screen.findAllByText(/GLM-5\.1 cannot recognize images or videos/i),
    ).resolves.not.toHaveLength(0);
    expect(
      screen.queryByLabelText("Open image preview for screenshot.png"),
    ).not.toBeInTheDocument();

    await user.upload(
      fileInput,
      new File(["plain text"], "notes.txt", { type: "text/plain" }),
    );

    await expect(
      screen.findByLabelText("Remove notes.txt"),
    ).resolves.toBeInTheDocument();

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await user.click(textarea);

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain" ? "Keep this pasted caption" : "";
        },
        items: [
          {
            kind: "file",
            getAsFile: () => {
              return new File(["pasted image"], "pasted.png", {
                type: "image/png",
              });
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(textarea).toHaveValue("Keep this pasted caption");
      expect(
        screen.queryByLabelText("Open image preview for pasted.png"),
      ).not.toBeInTheDocument();
    });

    await fill(textarea, "");

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/html") {
            return chatClipboardHtml({
              text: "Use the copied launch brief",
              attachments: [
                {
                  id: "copied-brief",
                  url: "https://cdn.vm7.io/artifacts/test/copied/copied-brief.md",
                  filename: "copied-brief.md",
                  contentType: "text/markdown",
                  size: 42,
                },
                {
                  id: "copied-image",
                  url: "https://cdn.vm7.io/artifacts/test/copied/copied-image.png",
                  filename: "copied-image.png",
                  contentType: "image/png",
                  size: 420,
                },
              ],
            });
          }
          return "";
        },
        items: [],
      },
    });

    await waitFor(() => {
      expect(textarea).toHaveValue("Use the copied launch brief");
      expect(
        screen.getByLabelText("Remove copied-brief.md"),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Open image preview for copied-image.png"),
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByText(/GLM-5\.1 cannot recognize images or videos/i)
          .length,
      ).toBeGreaterThan(0);
    });

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => {
          return type === "text/plain" ? "Do not insert oversized paste" : "";
        },
        items: [
          {
            kind: "file",
            getAsFile: () => {
              return oversizedFile("oversized-paste.txt", "text/plain");
            },
          },
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("oversized-paste.txt exceeds the 1 GB limit"),
      ).toBeInTheDocument();
      expect(textarea).toHaveValue("Use the copied launch brief");
    });

    const composer = composerElementFrom(textarea);
    fireEvent.dragOver(composer);
    fireEvent.dragLeave(composer, { relatedTarget: document.body });
    fireEvent.drop(composer, {
      dataTransfer: {
        files: [
          new File(["dropped image"], "dropped.png", { type: "image/png" }),
          oversizedFile("oversized-drop.txt", "text/plain"),
        ],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText("oversized-drop.txt exceeds the 1 GB limit"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText(/GLM-5\.1 cannot recognize images or videos/i)
          .length,
      ).toBeGreaterThan(0);
    });
  });

  it("hides an accepted visual attachment after switching to a text-only model", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    context.mocks.upload.success({
      id: "visual-model-switch",
      filename: "storyboard.png",
      contentType: "image/png",
      size: 128,
      url: "https://example.com/storyboard.png",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Claude Sonnet 4.6");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "storyboard.png", { type: "image/png" }),
    );

    await expect(
      screen.findByLabelText("Open image preview for storyboard.png"),
    ).resolves.toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );
    await user.click(await screen.findByRole("option", { name: /GLM-5\.1/ }));

    await waitFor(() => {
      expect(
        screen.getAllByText(/GLM-5\.1 cannot recognize images or videos/i)
          .length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByLabelText("Open image preview for storyboard.png"),
      ).not.toBeInTheDocument();
    });
  });

  it("manages agent connector access from the composer", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockAgentConnectorAuthorizations(["github"]);

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    const composerConnectorsButton =
      within(composer).getByLabelText("Connectors");

    click(composerConnectorsButton);

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Slack")).toBeInTheDocument();
      expect(screen.getByLabelText("Remove GitHub")).toBeInTheDocument();
      expect(screen.getByLabelText("Add Slack")).toBeInTheDocument();
    });

    await user.click(screen.getByText("GitHub"));

    await waitFor(() => {
      expect(screen.getByLabelText("Add GitHub")).toBeInTheDocument();
      expect(screen.getByLabelText("Add Slack")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Add Slack"));

    await waitFor(() => {
      expect(screen.getByLabelText("Remove Slack")).toBeInTheDocument();
    });

    click(composerConnectorsButton);

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("Find connectors...")).toBeNull();
    });

    click(composerConnectorsButton);

    await waitFor(() => {
      expect(screen.getByLabelText("Add GitHub")).toBeInTheDocument();
      expect(screen.getByLabelText("Remove Slack")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Add connectors"));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Available connectors to connect/u),
    ).toBeInTheDocument();

    await fill(
      within(dialog).getByPlaceholderText("Find connectors..."),
      "notion",
    );

    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Connect Notion"),
      ).toBeInTheDocument();
      expect(within(dialog).queryByLabelText("Connect Gmail")).toBeNull();
    });

    await user.click(within(dialog).getByLabelText("Connect Notion"));

    const notionDialog = await screen.findByRole("dialog", {
      name: "Notion",
    });
    expect(notionDialog).toBeInTheDocument();

    await user.click(within(notionDialog).getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Notion" }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getByText(/Available connectors to connect/u),
      ).toBeInTheDocument();
    });

    await user.click(within(dialog).getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByText(/Available connectors to connect/u),
      ).not.toBeInTheDocument();
    });
  });
});

describe("chat composer templates", () => {
  it("selects a presentation template from the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.ChatNewPresentationTemplates]: true,
      },
    });

    await openTemplatePicker(user, template);

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText(`Remove template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("renders presentation template card hover previews from HTML when available", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const blobHtml: Promise<string>[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((blob: Blob) => {
      blobHtml.push(blob.text());
      return `blob:template-preview-${String(blobHtml.length)}`;
    });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(
        `
          <!doctype html>
          <html>
            <body>
              <section data-vm0-slide data-slide-id="slide-one">
                <h1>Slide one</h1>
              </section>
              <section data-vm0-slide data-slide-id="slide-two">
                <h1>Slide two</h1>
              </section>
            </body>
          </html>
        `,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    try {
      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
        featureSwitches: {
          [FeatureSwitchKey.ChatTemplatePicker]: true,
          [FeatureSwitchKey.ChatNewPresentationTemplates]: true,
        },
      });

      click(
        await waitFor(() => {
          return screen.getByLabelText("Template");
        }),
      );
      await fill(screen.getByLabelText("Search templates"), template.title);
      const previewFrame = await screen.findByTestId(
        `${template.title} card HTML preview`,
      );
      const preview = previewFrame.parentElement;
      if (!preview) {
        throw new Error("Template preview not found");
      }
      Object.defineProperty(preview, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          return new DOMRect(0, 0, 300, 160);
        },
      });

      fireEvent.mouseEnter(preview);
      await waitFor(() => {
        expect(
          screen.getByTestId(`${template.title} card HTML preview`),
        ).toHaveAttribute("src", "blob:template-preview-1");
      });
      await expect(blobHtml[0]).resolves.toContain("Slide one");
      await expect(blobHtml[0]).resolves.toContain("--accent:#FF7A1A");
      await expect(blobHtml[0]).resolves.toContain("--s2:#F5B73E");
      await expect(blobHtml[0]).resolves.not.toContain("--fd:");
      await expect(blobHtml[0]).resolves.not.toContain("--fb:");

      fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });

      await waitFor(() => {
        expect(
          screen.getByTestId(`${template.title} card HTML preview`),
        ).toHaveAttribute("src", "blob:template-preview-2");
      });
      await expect(blobHtml[1]).resolves.toContain("Slide two");
      fireEvent.mouseLeave(preview);
    } finally {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as { createObjectURL?: unknown }).createObjectURL;
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", {
          configurable: true,
          value: originalRevokeObjectURL,
        });
      } else {
        delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      }
    }
  });

  it("navigates presentation template detail previews from the main preview", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.ChatNewPresentationTemplates]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await fill(screen.getByLabelText("Search templates"), template.title);
    click(screen.getByLabelText(`View template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByText("1 of 15")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Preview next slide"));

    await waitFor(() => {
      expect(screen.getByText("2 of 15")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Preview previous slide"));

    await waitFor(() => {
      expect(screen.getByText("1 of 15")).toBeInTheDocument();
    });
  });

  it("uses legacy presentation templates when the new catalog switch is off", async () => {
    const user = userEvent.setup({ delay: null });
    const legacyTemplate = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const newTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.ChatNewPresentationTemplates]: false,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(legacyTemplate.title)).toBeInTheDocument();
      expect(screen.queryByText(newTemplate.title)).not.toBeInTheDocument();
    });

    await user.click(
      screen.getByLabelText(`Select template ${legacyTemplate.title}`),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Remove template ${legacyTemplate.title}`),
      ).toBeInTheDocument();
    });
  });

  it("uses switched presentation templates when the new catalog switch is on", async () => {
    const legacyTemplate = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const newTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.ChatNewPresentationTemplates]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(newTemplate.title)).toBeInTheDocument();
      expect(screen.queryByText(legacyTemplate.title)).not.toBeInTheDocument();
    });
  });

  it("selects and removes an illustration style from the picker", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.ChatNewPresentationTemplates]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Illustration")).toBeInTheDocument();
    });
    click(tabByText("Illustration"));

    const heroAlt = `${illustrationTemplate.title} illustration preview`;
    const heroSrc = (index: number) => {
      return r2ImageTransformUrl(illustrationTemplate.previewImages[index]!, {
        width: 768,
        height: 768,
        quality: 72,
      });
    };

    await waitFor(() => {
      expect(screen.getByText(illustrationTemplate.title)).toBeInTheDocument();
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
      expect(screen.getAllByAltText(/ illustration preview$/u)).toHaveLength(
        ILLUSTRATION_TEMPLATE_ITEMS.length,
      );
    });

    // Variant thumbnails switch the hero inline within the card; there is no
    // longer a second preview dialog.
    const card = screen.getByAltText(heroAlt).closest<HTMLElement>("div.group");
    if (!card) {
      throw new Error("Illustration card not found");
    }
    click(within(card).getByLabelText("Show variant 2"));
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });
    click(within(card).getByLabelText("Show variant 1"));
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });

    await fill(screen.getByLabelText("Search templates"), "no matching style");
    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search templates"), "ink");
    click(
      screen.getByLabelText(`Select template ${illustrationTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
      ).toBeInTheDocument();
    });

    click(
      screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(
          `Remove template ${illustrationTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("navigates illustration variants by clicking the hero image halves and keeps the selected thumbnail in view", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 200,
          bottom: 200,
          width: 200,
          height: 200,
          toJSON: () => {
            return {};
          },
        };
      },
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.ChatNewPresentationTemplates]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Illustration")).toBeInTheDocument();
    });
    click(tabByText("Illustration"));

    const heroAlt = `${illustrationTemplate.title} illustration preview`;
    const heroSrc = (index: number) => {
      return r2ImageTransformUrl(illustrationTemplate.previewImages[index]!, {
        width: 768,
        height: 768,
        quality: 72,
      });
    };
    const lastIndex = illustrationTemplate.previewImages.length - 1;

    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });

    // Clicking the right half advances to the next variant.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 150 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });

    // Switching the variant scrolls the now-selected thumbnail fully into view.
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });

    // Clicking the left half goes back to the previous variant.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 10 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });

    // Clicking the left half from the first variant wraps to the last one.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 10 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute(
        "src",
        heroSrc(lastIndex),
      );
    });
  });

  it("keeps historical illustration labels behind the template picker feature switch", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      chatMessages: [
        {
          id: "msg-illustration-template-history",
          role: "user",
          content: "Make an illustrated launch card",
          runId: "run-illustration-template-history",
          generationTemplate: {
            type: "illustration",
            selection: {
              illustrationStyleId: illustrationTemplate.illustrationStyleId,
            },
          },
          createdAt: NOW,
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Make an illustrated launch card"),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText(
          `Message template ${illustrationTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("opens video templates by default when only the video picker is enabled", async () => {
    const videoStyle = VIDEO_TEMPLATE_ITEMS[0]!;
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const pauseSpy = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    mockChatLifecycle(context, { threadId: THREAD_ID });

    try {
      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
        featureSwitches: { [FeatureSwitchKey.VideoTemplatePicker]: true },
      });

      click(
        await waitFor(() => {
          return screen.getByLabelText("Template");
        }),
      );

      await waitFor(() => {
        expect(tabByText("Video")).toBeInTheDocument();
        expect(
          screen.getByLabelText(`Select video template ${videoStyle.title}`),
        ).toBeInTheDocument();
        const previewVideo = Array.from(
          document.querySelectorAll("video"),
        ).find((video) => {
          return video.getAttribute("src") === videoStyle.previewVideo;
        });
        if (!previewVideo) {
          throw new Error("Video template preview video not found");
        }
        expect(previewVideo).toHaveAttribute(
          "poster",
          r2ImageTransformUrl(videoStyle.previewImage, {
            width: 640,
            height: 360,
          }),
        );
        expect(previewVideo).toHaveAttribute("preload", "none");
        expect(screen.queryByText("Presentation")).not.toBeInTheDocument();
        expect(screen.queryByText("Illustration")).not.toBeInTheDocument();
      });

      const previewVideo = Array.from(document.querySelectorAll("video")).find(
        (video) => {
          return video.getAttribute("src") === videoStyle.previewVideo;
        },
      );
      if (!previewVideo) {
        throw new Error("Video template preview video not found");
      }
      fireEvent.mouseEnter(previewVideo);
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(previewVideo.defaultMuted).toBeTruthy();
      expect(previewVideo.muted).toBeTruthy();

      previewVideo.currentTime = 3;
      fireEvent.mouseLeave(previewVideo);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(previewVideo.currentTime).toBe(0);
    } finally {
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it("queues a selected template during an active run and clears the picker state", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    mockActiveTemplateThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    await selectTemplate(user, template);
    const queuedTextarea = await screen.findByPlaceholderText(
      /Type your next message/,
    );
    await sendMessageInUI(
      user,
      queuedTextarea as HTMLTextAreaElement,
      "Queue a matching deck",
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Queue a matching deck",
      );
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps newer template selections visible after a queued template is sent", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const nextTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockActiveTemplateThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    await selectTemplate(user, template);
    await sendMessageInUI(
      user,
      (await screen.findByPlaceholderText(
        /Type your next message/,
      )) as HTMLTextAreaElement,
      "Queue a matching deck",
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Queue a matching deck",
      );
    });

    await selectIllustrationTemplate(user, nextTemplate);

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${nextTemplate.title}`),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText(`Remove template ${template.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("selects and removes a video template from the picker", async () => {
    const videoStyle = VIDEO_TEMPLATE_ITEMS.find((item) => {
      return item.title === "Luxury Product Macro";
    })!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.VideoTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Video")).toBeInTheDocument();
    });
    click(tabByText("Video"));

    await waitFor(() => {
      expect(screen.queryByText("Brand & Commercial")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Select video template ${videoStyle.title}`),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search templates"), "no matching style");
    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search templates"), "luxury");
    click(screen.getByLabelText(`Select video template ${videoStyle.title}`));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove video template ${videoStyle.title}`),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText(`Remove video template ${videoStyle.title}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove video template ${videoStyle.title}`),
      ).not.toBeInTheDocument();
    });
  });

  it("reopens the picker on the presentation tab from the selected chip", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.VideoTemplatePicker]: true,
      },
    });

    await selectTemplate(user, template);

    click(await screen.findByLabelText(`Preview template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(tabByText("Presentation")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("reopens on the illustration tab from the chip after the last-used tab changed", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    // Select an illustration style, which leaves the picker on the
    // Illustration tab.
    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await waitFor(() => {
      expect(tabByText("Illustration")).toBeInTheDocument();
    });
    click(tabByText("Illustration"));
    click(
      await screen.findByLabelText(
        `Select template ${illustrationTemplate.title}`,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Remove template ${illustrationTemplate.title}`),
      ).toBeInTheDocument();
    });

    // Move the last-used tab back to Presentation, then close without changing
    // the selection so the persisted tab no longer matches the selection.
    click(screen.getByLabelText("Template"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    click(tabByText("Presentation"));
    await waitFor(() => {
      expect(tabByText("Presentation")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Clicking the chip reopens on the tab matching the selection's type.
    click(
      screen.getByLabelText(`Preview template ${illustrationTemplate.title}`),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(tabByText("Illustration")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  it("removes the selected template from the chip without opening the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await selectTemplate(user, template);

    click(screen.getByLabelText(`Remove template ${template.title}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(`Preview template ${template.title}`),
    ).not.toBeInTheDocument();
  });
});
