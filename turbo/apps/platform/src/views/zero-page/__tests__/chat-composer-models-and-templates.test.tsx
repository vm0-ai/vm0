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
import {
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { templateCardThemeIdBySlug$ } from "../../../signals/zero-page/zero-chat-composer.ts";
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

function expectTextBefore(firstText: string, secondText: string): void {
  const first = screen.getByText(firstText);
  const second = screen.getByText(secondText);
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
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

function presentationTemplateGridScrollContainer(): HTMLElement {
  const scrollContainer = screen
    .getByRole("dialog")
    .querySelector<HTMLElement>("[data-presentation-template-grid-scroll]");
  if (!scrollContainer) {
    throw new Error("Presentation template grid scroll container not found");
  }
  return scrollContainer;
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

function billingStatus(tier: string): BillingStatusResponse {
  return {
    tier,
    credits: 20_000,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function mockBillingTier(tier: string): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier));
  });
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

function resetPresentationCardPreviewImageDecodeCache(): void {
  Reflect.deleteProperty(
    globalThis,
    "vm0PresentationCardPreviewImageDecodeCache",
  );
}

function resetPresentationTemplateThumbnailCache(): void {
  Reflect.deleteProperty(globalThis, "vm0PresentationTemplateThumbnailCache");
}

function resetTemplatePreviewPrewarmCache(): void {
  Reflect.deleteProperty(globalThis, "vm0TemplatePreviewPrewarmCache");
  Reflect.deleteProperty(globalThis, "vm0TemplatePreviewIdlePrewarmKeys");
}

function trackTemplatePreviewImagePreloads(): {
  readonly srcs: readonly string[];
  readonly restore: () => void;
} {
  const srcs: string[] = [];
  const originalGlobalImage = Object.getOwnPropertyDescriptor(
    globalThis,
    "Image",
  );
  const originalWindowImage = Object.getOwnPropertyDescriptor(window, "Image");

  class TestImagePreload {
    decoding = "";
    loading = "";
    fetchPriority = "";
    #src = "";

    decode(): Promise<void> {
      return Promise.resolve();
    }

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      srcs.push(value);
    }
  }

  const imageConstructor = TestImagePreload as unknown as typeof Image;
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    value: imageConstructor,
    writable: true,
  });
  Object.defineProperty(window, "Image", {
    configurable: true,
    value: imageConstructor,
    writable: true,
  });

  return {
    srcs,
    restore: () => {
      if (originalGlobalImage) {
        Object.defineProperty(globalThis, "Image", originalGlobalImage);
      } else {
        Reflect.deleteProperty(globalThis, "Image");
      }
      if (originalWindowImage) {
        Object.defineProperty(window, "Image", originalWindowImage);
      } else {
        Reflect.deleteProperty(window, "Image");
      }
    },
  };
}

function mockImmediateIdleCallback(): () => void {
  const originalRequestIdleCallback = Object.getOwnPropertyDescriptor(
    window,
    "requestIdleCallback",
  );
  Object.defineProperty(window, "requestIdleCallback", {
    configurable: true,
    value: (callback: IdleRequestCallback): number => {
      callback({
        didTimeout: false,
        timeRemaining: () => {
          return 50;
        },
      });
      return 1;
    },
    writable: true,
  });

  return () => {
    if (originalRequestIdleCallback) {
      Object.defineProperty(
        window,
        "requestIdleCallback",
        originalRequestIdleCallback,
      );
    } else {
      Reflect.deleteProperty(window, "requestIdleCallback");
    }
  };
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

  click(screen.getByLabelText(`Preview ${template.title} at current slide`));
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
  agentId = OTHER_AGENT_ID,
}: {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly agentId?: string;
}) {
  return {
    id: crypto.randomUUID(),
    agentId,
    agentName: null,
    agentDisplayName: agentId === AGENT_ID ? "Scout" : "Other Agent",
    name,
    displayName,
    description,
    visibility: "public" as const,
    requestToPublish: false,
    ownerUserId: "user-1",
    canManage: true,
  };
}

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
  resetPresentationTemplateHtmlPreviewCache();
  resetPresentationCardPreviewImageDecodeCache();
  resetPresentationTemplateThumbnailCache();
  resetTemplatePreviewPrewarmCache();
});

describe("chat composer models", () => {
  it("keeps the agent chat composer at three-line height", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {},
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    expect(textarea).toHaveAttribute("rows", "3");
    expect(textarea).toHaveClass("min-h-[96px]");
    expect(textarea).not.toHaveClass("min-h-[44px]");
  });

  it("uses the mobile single-line height in chat thread composers", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {},
    });

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    expect(textarea).toHaveAttribute("rows", "1");
    expect(textarea).toHaveClass("min-h-[44px]", "md:min-h-[96px]");
  });

  it("keeps the agent chat slash composer at three-line height", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ChatSlashWorkflowCommands]: true,
      },
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[96px]");
    expect(editor).not.toHaveClass("min-h-[44px]");
  });

  it("uses the mobile single-line height in chat thread slash composers", async () => {
    mockOrgModelRoutes("kimi-k2.7-code");
    mockAgent();
    mockThread();
    context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatSlashWorkflowCommands]: true,
      },
    });

    const editor = await findComposerEditor();
    expect(editor).toHaveClass("min-h-[44px]", "md:min-h-[96px]");
  });

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
          agentId: AGENT_ID,
        }),
        workflowSummary({
          name: "support-escalation",
          displayName: "Support Escalation",
          description: "Summarize customer issues for handoff",
          agentId: AGENT_ID,
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
          agentId: OTHER_AGENT_ID,
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
          agentId: OTHER_AGENT_ID,
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
          agentId: AGENT_ID,
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
            agentId: AGENT_ID,
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

  it("opens compare plans from limited-free-1 Pro composer model items", async () => {
    const user = userEvent.setup({ delay: null });
    mockBillingTier("limited-free-1");
    context.mocks.data.orgModelPolicies([
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000701",
        model: "kimi-k2.7-code",
        modelLabel: "Kimi K2.7 Code",
        isDefault: true,
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
      buildModelPolicy({
        id: "00000000-0000-4000-a000-000000000702",
        model: "gpt-5.5",
        modelLabel: "GPT-5.5",
        defaultProviderType: "vm0",
        credentialScope: "org",
      }),
    ]);
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await expectComposerModel("Kimi K2.7 Code");
    await user.click(screen.getByRole("combobox", { name: "Kimi K2.7 Code" }));
    await user.click(
      await screen.findByRole("option", { name: /GPT-5\.5.*Pro/u }),
    );

    await expect(
      screen.findByRole("heading", { name: "Compare plans" }),
    ).resolves.toBeInTheDocument();
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

  it("keeps composer connector order independent of authorization state", async () => {
    const user = userEvent.setup({ delay: null });
    mockOrgModelRoutes("claude-sonnet-4-6");
    mockAgent();
    mockManyConnectedConnectors();
    mockAgentConnectorAuthorizations(["slack"]);

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );
    click(within(composer).getByLabelText("Connectors"));

    await waitFor(() => {
      expect(screen.getByLabelText("Add GitHub")).toBeInTheDocument();
      expect(screen.getByLabelText("Remove Slack")).toBeInTheDocument();
      expectTextBefore("GitHub", "Slack");
    });

    await user.click(screen.getByLabelText("Remove Slack"));

    await waitFor(() => {
      expect(screen.getByLabelText("Add Slack")).toBeInTheDocument();
      expectTextBefore("GitHub", "Slack");
    });
  });
});

describe("chat composer templates", () => {
  it("prewarms template previews only after the template button is used", async () => {
    const imagePreloads = trackTemplatePreviewImagePreloads();
    const restoreIdleCallback = mockImmediateIdleCallback();
    const templatePreviewSrcs = () => {
      return imagePreloads.srcs.filter((src) => {
        return src.includes("/cdn-cgi/image/width=480,height=270");
      });
    };

    try {
      mockChatLifecycle(context, { threadId: THREAD_ID });

      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
        featureSwitches: {
          [FeatureSwitchKey.ChatTemplatePicker]: true,
        },
      });

      const templateButton = await waitFor(() => {
        return screen.getByLabelText("Template");
      });

      expect(templatePreviewSrcs()).toStrictEqual([]);

      click(templateButton);

      await waitFor(() => {
        expect(templatePreviewSrcs().length).toBeGreaterThan(0);
      });
    } finally {
      restoreIdleCallback();
      imagePreloads.restore();
      resetTemplatePreviewPrewarmCache();
    }
  });

  it("places the template control immediately after attach", async () => {
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    const composer = composerElementFrom(
      await screen.findByPlaceholderText(PLACEHOLDER),
    );

    await waitFor(() => {
      const controls = Array.from(
        composer.querySelectorAll(
          [
            'button[aria-label="Attach"]',
            'button[aria-label="Template"]',
            'button[aria-label="Connectors"]',
          ].join(","),
        ),
      ).map((button) => {
        return button.getAttribute("aria-label");
      });

      expect(controls).toStrictEqual(["Attach", "Template", "Connectors"]);
    });
  });

  it("opens the template picker without focusing the tabs on small screens", async () => {
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.VideoTemplatePicker]: true,
      },
    });

    const templateButton = await waitFor(() => {
      return screen.getByLabelText("Template");
    });
    expect(templateButton.querySelector("img")).toBeNull();
    expect(templateButton.querySelector("svg")).toBeInTheDocument();

    click(templateButton);

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    expect(tabByText("Presentation")).toBeInTheDocument();
    expect(tabByText("Illustration")).toBeInTheDocument();
    expect(tabByText("Video")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(tabByText("Presentation"));

    const tabScroller = document.querySelector(
      "[data-template-picker-tabs-scroll]",
    );
    expect(tabScroller).toBeInstanceOf(HTMLElement);
    expect(tabScroller).toHaveClass("overflow-x-auto");
    expect(tabScroller).toHaveClass("sm:overflow-visible");
    expect(tabScroller).toHaveClass("[scrollbar-width:thin]");
  });

  it("selects a presentation template from the picker", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
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
    const prismTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.colorSystemId === "color-system:prism";
    });
    if (prismTemplate === undefined) {
      throw new Error("Prism presentation template not found");
    }
    const blobHtml: Promise<string>[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((blob: Blob) => {
      blobHtml.push(blob.text());
      return `blob:template-preview-${String(blobHtml.length)}`;
    });
    const htmlForFrame = (frame: HTMLElement): Promise<string> => {
      const src = frame.getAttribute("src");
      if (src === null) {
        throw new Error("Preview frame src not set");
      }
      const match = /^blob:template-preview-(\d+)$/.exec(src);
      if (match === null) {
        throw new Error(`Unexpected preview frame src: ${src}`);
      }
      const html = blobHtml[Number(match[1]) - 1];
      if (html === undefined) {
        throw new Error(`Preview blob not found for ${src}`);
      }
      return html;
    };
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
        },
      });

      click(
        await waitFor(() => {
          return screen.getByLabelText("Template");
        }),
      );
      await fill(screen.getByLabelText("Search templates"), template.title);
      expect(
        screen.queryByLabelText(`View template ${template.title}`),
      ).not.toBeInTheDocument();
      const currentPreviewFrame = () => {
        return screen.getByTestId(`${template.title} card HTML preview`);
      };
      expect(
        screen.queryByTestId(`${template.title} card HTML preview`),
      ).not.toBeInTheDocument();
      const preview = screen.getByLabelText(
        `Preview ${template.title} at current slide`,
      ).parentElement;
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
          screen.queryByTestId(`${template.title} card HTML preview`),
        ).not.toBeInTheDocument();
      });

      fireEvent.mouseEnter(preview);
      fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });

      await waitFor(async () => {
        await expect(htmlForFrame(currentPreviewFrame())).resolves.toContain(
          "Slide two",
        );
      });
      expect(currentPreviewFrame()).toHaveAttribute("tabindex", "-1");
      const secondPreviewHtml = await htmlForFrame(currentPreviewFrame());
      expect(secondPreviewHtml).toContain("--accent:#FF7A1A");
      expect(secondPreviewHtml).toContain("--s2:#F5B73E");
      expect(secondPreviewHtml).not.toContain("--fd:");
      expect(secondPreviewHtml).not.toContain("--fb:");
      const createObjectUrlCountBeforeLeave = createObjectURL.mock.calls.length;
      fireEvent.mouseLeave(preview);
      await waitFor(() => {
        expect(
          screen.queryByTestId(`${template.title} card HTML preview`),
        ).not.toBeInTheDocument();
      });
      expect(createObjectURL).toHaveBeenCalledTimes(
        createObjectUrlCountBeforeLeave,
      );

      await fill(
        screen.getByLabelText("Search templates"),
        prismTemplate.title,
      );
      const currentPrismPreviewFrame = () => {
        return screen.getByTestId(`${prismTemplate.title} card HTML preview`);
      };
      expect(
        screen.queryByTestId(`${prismTemplate.title} card HTML preview`),
      ).not.toBeInTheDocument();
      const prismPreview = screen.getByLabelText(
        `Preview ${prismTemplate.title} at current slide`,
      ).parentElement;
      if (!prismPreview) {
        throw new Error("Prism template preview not found");
      }
      Object.defineProperty(prismPreview, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          return new DOMRect(0, 0, 300, 160);
        },
      });

      fireEvent.mouseEnter(prismPreview);
      await waitFor(() => {
        expect(
          screen.queryByTestId(`${prismTemplate.title} card HTML preview`),
        ).not.toBeInTheDocument();
      });
      fireEvent.mouseMove(prismPreview, { clientX: 300, clientY: 80 });
      await waitFor(() => {
        expect(
          screen.getByTestId(`${prismTemplate.title} card HTML preview`),
        ).toHaveAttribute("src", expect.stringMatching(/^blob:/));
      });
      const prismPreviewHtml = await htmlForFrame(currentPrismPreviewFrame());
      expect(prismPreviewHtml).toContain("--accent:#7257E6");
      expect(prismPreviewHtml).toContain("--s1:#FF6B4A");
      expect(prismPreviewHtml).toContain("--s2:#AEE63E");
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

  it("scrubs presentation card slides by slide count after the hover preview loads", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug === "bloom-pitch";
    });
    if (template === undefined) {
      throw new Error("Bloom pitch presentation template not found");
    }
    const slideCount = template.slideCount;
    if (slideCount === undefined) {
      throw new Error("Bloom pitch presentation slide count not found");
    }
    expect(template.previewImages).toHaveLength(1);
    expect(slideCount).toBe(15);
    const previewFetch = createDeferredPromise<Response>(AbortSignal.any([]));
    const blobHtml: Promise<string>[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((blob: Blob) => {
      blobHtml.push(blob.text());
      return `blob:template-preview-late-${String(blobHtml.length)}`;
    });
    const htmlForFrame = (frame: HTMLElement): Promise<string> => {
      const src = frame.getAttribute("src");
      if (src === null) {
        throw new Error("Preview frame src not set");
      }
      const match = /^blob:template-preview-late-(\d+)$/.exec(src);
      if (match === null) {
        throw new Error(`Unexpected preview frame src: ${src}`);
      }
      const html = blobHtml[Number(match[1]) - 1];
      if (html === undefined) {
        throw new Error(`Preview blob not found for ${src}`);
      }
      return html;
    };
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    let previewFetchCount = 0;
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      previewFetchCount += 1;
      return previewFetch.promise;
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await fill(screen.getByLabelText("Search templates"), template.title);
    const preview = screen.getByLabelText(
      `Preview ${template.title} at current slide`,
    ).parentElement;
    if (!preview) {
      throw new Error("Template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });

    try {
      previewFetch.resolve(
        new Response(
          `<!doctype html><html><body>${Array.from(
            { length: slideCount },
            (_, index) => {
              const slideNumber = index + 1;
              return `<section data-vm0-slide data-slide-id="slide-${slideNumber}"><h1>Slide ${slideNumber}</h1></section>`;
            },
          ).join("")}</body></html>`,
          { headers: { "Content-Type": "text/html" } },
        ),
      );
      fireEvent.mouseEnter(preview);
      await waitFor(() => {
        expect(previewFetchCount).toBe(1);
      });

      await waitFor(async () => {
        fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });
        await expect(
          htmlForFrame(
            screen.getByTestId(`${template.title} card HTML preview`),
          ),
        ).resolves.toContain("Slide 15");
      });
    } finally {
      if (!previewFetch.settled()) {
        previewFetch.reject(new Error("Preview fetch intentionally cancelled"));
      }
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

  it("uses the presentation detail theme for template selection", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug !== PRESENTATION_TEMPLATE_PICKER_ITEMS[0]?.slug;
    });
    if (template === undefined) {
      throw new Error("Second presentation template not found");
    }
    let selectedColorSystemId: string | undefined;
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      onRunCreate: (body) => {
        if (body.generationTemplate?.type === "presentation") {
          selectedColorSystemId =
            body.generationTemplate.selection.colorSystemId;
        }
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await fill(screen.getByLabelText("Search templates"), template.title);
    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByLabelText(`Preview ${template.title} at current slide`),
    );
    const templateDialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });
    await user.click(
      within(templateDialog).getByLabelText("Select style Prism"),
    );
    expect(
      within(templateDialog).getByLabelText("Select style Prism"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      context.store.get(templateCardThemeIdBySlug$)[template.slug],
    ).toBeUndefined();

    const prismCardPreview = template.cardPreviewImagesByTheme?.prism;
    if (!prismCardPreview) {
      throw new Error("Prism card preview not found");
    }
    expect(
      within(templateDialog).getByTestId(
        `${template.title} detail image preview`,
      ),
    ).toHaveAttribute(
      "src",
      r2ImageTransformUrl(template.previewImages[0]!, {
        width: 480,
        height: 270,
      }),
    );

    await user.click(
      within(templateDialog).getByLabelText(
        `Select template ${template.title}`,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });
    expect(context.store.get(templateCardThemeIdBySlug$)).toMatchObject({
      [template.slug]: "prism",
    });

    await user.click(
      screen.getByLabelText(`Preview template ${template.title}`),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId(`${template.title} card image preview`),
      ).toHaveAttribute(
        "src",
        r2ImageTransformUrl(prismCardPreview, { width: 480, height: 270 }),
      );
    });
    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await sendMessageInUI(
      user,
      (await screen.findByPlaceholderText(PLACEHOLDER)) as HTMLTextAreaElement,
      "Create a launch deck",
    );
    await waitFor(() => {
      expect(selectedColorSystemId).toBe("color-system:prism");
    });
  });

  it("selects presentation templates with the default card theme", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return item.slug !== PRESENTATION_TEMPLATE_PICKER_ITEMS[0]?.slug;
    });
    if (template === undefined) {
      throw new Error("Second presentation template not found");
    }
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await fill(screen.getByLabelText("Search templates"), template.title);
    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText(`Preview ${template.title} at current slide`));
    const templateDialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });
    const defaultThemeLabel = (
      template.colorSystemId ?? "color-system:warm-sand"
    )
      .replace("color-system:", "")
      .replace(/-/g, " ");
    expect(
      within(templateDialog).getByLabelText(
        new RegExp(`^Select style ${defaultThemeLabel}$`, "i"),
      ),
    ).toHaveAttribute("aria-pressed", "true");

    const templateButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);

    expect(
      screen.queryByLabelText(`Change theme for ${template.title}`),
    ).not.toBeInTheDocument();

    click(screen.getByLabelText(`Select template ${template.title}`));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${template.title}`),
      ).toBeInTheDocument();
    });
  });

  it("opens presentation template detail at the scrubbed card slide", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const lastSlideNumber = template.slideCount;
    if (lastSlideNumber === undefined) {
      throw new Error("Presentation template slide count not found");
    }
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", () => {
      return new Response(
        `
          <!doctype html>
          <html>
            <body>
              ${Array.from({ length: lastSlideNumber }, (_, index) => {
                return `<section data-vm0-slide data-slide-id="slide-${String(
                  index + 1,
                )}"><h1>Slide ${String(index + 1)}</h1></section>`;
              }).join("")}
            </body>
          </html>
        `,
        { headers: { "Content-Type": "text/html" } },
      );
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await fill(screen.getByLabelText("Search templates"), template.title);

    const preview = screen.getByLabelText(
      `Preview ${template.title} at current slide`,
    ).parentElement;
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
        screen.queryByTestId(`${template.title} card HTML preview`),
      ).not.toBeInTheDocument();
    });
    fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });
    const animationFrame = createDeferredPromise<void>(AbortSignal.any([]));
    window.requestAnimationFrame(() => {
      animationFrame.resolve();
    });
    try {
      await animationFrame.promise;
    } finally {
      if (!animationFrame.settled()) {
        animationFrame.reject(new Error("Animation frame cancelled"));
      }
    }
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Preview slide ${String(lastSlideNumber)}`),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(
      screen.queryByText(`${String(lastSlideNumber)} of 15`),
    ).not.toBeInTheDocument();
  });

  it("preserves presentation template grid scroll when returning from detail preview", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );

    const initialScrollContainer = presentationTemplateGridScrollContainer();
    initialScrollContainer.scrollTop = 360;
    fireEvent.scroll(initialScrollContainer);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    const templateDialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });

    click(within(templateDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(presentationTemplateGridScrollContainer().scrollTop).toBe(360);
    });

    const restoredAfterClose = presentationTemplateGridScrollContainer();
    restoredAfterClose.scrollTop = 520;
    fireEvent.scroll(restoredAfterClose);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));
    await waitFor(() => {
      expect(
        within(templateDialog).getByRole("heading", {
          name: `Template / ${template.title}`,
        }),
      ).toBeInTheDocument();
    });

    const templateButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);

    await waitFor(() => {
      expect(presentationTemplateGridScrollContainer().scrollTop).toBe(520);
    });
  });

  it("resumes presentation template detail preview loading after reopening the same slide", async () => {
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const previewFetch = createDeferredPromise<Response>(AbortSignal.any([]));
    let previewFetchCount = 0;
    const blobHtml: Promise<string>[] = [];
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        blobHtml.push(blob.text());
        return `blob:template-detail-${String(blobHtml.length)}`;
      }),
    });
    const htmlForDetailFrame = (frame: HTMLElement): Promise<string> => {
      const src = frame.getAttribute("src");
      if (src === null) {
        throw new Error("Detail preview frame src not set");
      }
      const match = /^blob:template-detail-(\d+)$/.exec(src);
      if (match === null) {
        throw new Error(`Unexpected detail preview frame src: ${src}`);
      }
      const html = blobHtml[Number(match[1]) - 1];
      if (html === undefined) {
        throw new Error(`Detail preview blob not found for ${src}`);
      }
      return html;
    };
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Reflect.set(globalThis, "vm0LoadTemplateDetailHtmlPreviewInHappyDom", true);
    context.mocks.http.get("*/__vm0-dev-artifact-fetch", ({ request }) => {
      const requestedUrl = new URL(request.url).searchParams.get("url");
      if (requestedUrl === template.embedUrl) {
        previewFetchCount += 1;
        return previewFetch.promise;
      }
      return new Response("<!doctype html><html><body></body></html>", {
        headers: { "Content-Type": "text/html" },
      });
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    try {
      detachedSetupPage({
        context,
        path: `/chats/${THREAD_ID}`,
        featureSwitches: {
          [FeatureSwitchKey.ChatTemplatePicker]: true,
        },
      });

      click(
        await waitFor(() => {
          return screen.getByLabelText("Template");
        }),
      );
      await fill(screen.getByLabelText("Search templates"), template.title);
      click(
        screen.getByLabelText(`Preview ${template.title} at current slide`),
      );

      await waitFor(() => {
        expect(previewFetchCount).toBe(1);
        expect(
          screen.getByTestId(`${template.title} detail HTML preview`),
        ).not.toHaveAttribute("src");
      });

      const templateButton = queryAllByRoleFast("button").find((candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      });
      if (!templateButton) {
        throw new Error("Template button not found");
      }
      click(templateButton);
      click(
        screen.getByLabelText(`Preview ${template.title} at current slide`),
      );

      previewFetch.resolve(
        new Response(
          `
            <!doctype html>
            <html>
              <body>
                <section data-vm0-slide data-slide-id="slide-one">
                  <h1>Slide one</h1>
                </section>
              </body>
            </html>
          `,
          { headers: { "Content-Type": "text/html" } },
        ),
      );

      await waitFor(() => {
        expect(
          screen.getByTestId(`${template.title} detail HTML preview`),
        ).toHaveAttribute("src", expect.stringMatching(/^blob:/));
      });
      await expect(
        htmlForDetailFrame(
          screen.getByTestId(`${template.title} detail HTML preview`),
        ),
      ).resolves.toContain("Slide one");
      expect(previewFetchCount).toBe(1);
    } finally {
      Reflect.deleteProperty(
        globalThis,
        "vm0LoadTemplateDetailHtmlPreviewInHappyDom",
      );
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
    Reflect.set(globalThis, "vm0PresentationTemplateHtmlPreviewCache", {
      activeIndexes: new Map<string, number>(),
      activeTokens: new Map<string, symbol>(),
      defaultLoads: new Set<string>(),
      detailTokens: new Map<string, symbol>(),
      drafts: new Map([
        [
          template.embedUrl,
          {
            blocks: [],
            html: `<!doctype html><html><head><style>:root { --bg: white; --ink: black; } section { width: 1600px; height: 900px; background: var(--bg); color: var(--ink); }</style></head><body>${template.previewImages
              .map((_, index) => {
                return `<section data-vm0-slide data-slide-id="slide-${index + 1}"><h1>Slide ${index + 1}</h1></section>`;
              })
              .join("")}</body></html>`,
            slides: template.previewImages.map((_, index) => {
              return {
                id: `slide-${index + 1}`,
                notes: "",
                title: `Slide ${index + 1}`,
              };
            }),
          },
        ],
      ]),
      failed: new Set<string>(),
      pendingLoads: new Map<string, Promise<null>>(),
    });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
      },
    });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Template");
      }),
    );
    await fill(screen.getByLabelText("Search templates"), template.title);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    const templateDialog = screen.getByRole("dialog");
    expect(
      within(templateDialog).getByRole("heading", {
        name: `Template / ${template.title}`,
      }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Preview previous slide")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByLabelText("Preview previous slide")).not.toHaveClass(
      "focus-visible:ring-ring",
    );
    expect(screen.getByLabelText("Preview next slide")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByLabelText("Preview next slide")).not.toHaveClass(
      "focus-visible:ring-ring",
    );

    await waitFor(() => {
      expect(
        within(templateDialog).getByLabelText("Preview slide 1"),
      ).toHaveAttribute("aria-pressed", "true");
    });
    const detailPreviewFrame = screen.getByTestId(
      `${template.title} detail HTML preview`,
    );
    expect(detailPreviewFrame).toHaveAttribute("tabindex", "-1");
    expect(detailPreviewFrame).toHaveAttribute(
      "src",
      expect.stringMatching(/^blob:/),
    );
    expect(screen.queryByText("1 of 15")).not.toBeInTheDocument();
    const firstSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 1");
    const secondSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 2");
    const backButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!backButton) {
      throw new Error("Template button not found");
    }
    backButton.focus();
    fireEvent.keyDown(backButton, { key: "Tab" });
    expect(document.activeElement).toBe(firstSlidePreviewButton);
    fireEvent.keyDown(firstSlidePreviewButton, { key: "Tab" });
    expect(document.activeElement).toBe(secondSlidePreviewButton);
    expect(firstSlidePreviewButton.querySelector("iframe")).toBeNull();
    expect(firstSlidePreviewButton.querySelector("img")).toBeNull();
    expect(
      firstSlidePreviewButton.querySelector(
        `[aria-label="${template.title} slide 1 preview"]`,
      ),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        firstSlidePreviewButton.querySelector(
          `[aria-label="${template.title} slide 1 preview"]`,
        )?.shadowRoot,
      ).not.toBeNull();
    });
    const carnivalShadowRoot = firstSlidePreviewButton.querySelector(
      `[aria-label="${template.title} slide 1 preview"]`,
    )?.shadowRoot;
    const carnivalShadowPreviewRoot =
      carnivalShadowRoot?.querySelector<HTMLElement>(
        ".vm0-shadow-preview-root",
      ) ?? null;
    expect(carnivalShadowPreviewRoot?.style.getPropertyValue("--accent")).toBe(
      "#FF7A1A",
    );
    expect(
      carnivalShadowRoot?.querySelector("[contenteditable]"),
    ).not.toBeInTheDocument();
    expect(
      carnivalShadowRoot?.querySelector("[tabindex]"),
    ).not.toBeInTheDocument();
    expect(firstSlidePreviewButton.querySelectorAll("span")).toHaveLength(1);
    expect(screen.getByLabelText("Select style Carnival")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    click(screen.getByLabelText("Select style Prism"));
    expect(screen.getByLabelText("Select style Prism")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(templateDialog)
        .getByLabelText("Preview slide 1")
        .querySelector("iframe"),
    ).toBeNull();
    const prismSlidePreviewButton =
      within(templateDialog).getByLabelText("Preview slide 1");
    expect(
      prismSlidePreviewButton.querySelector(
        `[aria-label="${template.title} slide 1 preview"]`,
      )?.shadowRoot,
    ).toBe(carnivalShadowRoot);
    expect(carnivalShadowPreviewRoot?.style.getPropertyValue("--accent")).toBe(
      "#7257E6",
    );
    expect(prismSlidePreviewButton.querySelectorAll("span")).toHaveLength(1);

    const templateButton = queryAllByRoleFast("button", templateDialog).find(
      (candidate) => {
        return (
          candidate.textContent?.replace(/\s+/g, " ").trim() === "Template"
        );
      },
    );
    if (!templateButton) {
      throw new Error("Template button not found");
    }
    click(templateButton);
    click(screen.getByLabelText(`Preview ${template.title} at current slide`));

    await waitFor(() => {
      expect(
        within(templateDialog).getByLabelText("Preview slide 1"),
      ).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.getByLabelText("Select style Carnival")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(
      screen.getByLabelText(`${template.title} slide preview`),
      {
        key: "ArrowRight",
      },
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(
      screen.getByLabelText(`${template.title} slide preview`),
      {
        key: "ArrowLeft",
      },
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 1")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    const themeButton = screen.getByLabelText("Select style Carnival");
    themeButton.focus();
    expect(themeButton).toHaveFocus();
    fireEvent.keyDown(themeButton, {
      key: "ArrowRight",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(themeButton, {
      key: "ArrowLeft",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 1")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(screen.getByLabelText("Preview slide 1"), {
      key: "ArrowRight",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 2")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    fireEvent.keyDown(screen.getByLabelText("Preview slide 2"), {
      key: "ArrowLeft",
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Preview slide 1")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
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
      if (index === 0 && illustrationTemplate.cardPreviewImage) {
        return r2ImageTransformUrl(illustrationTemplate.cardPreviewImage, {
          width: 512,
          height: 512,
          quality: 72,
        });
      }
      return r2ImageTransformUrl(illustrationTemplate.previewImages[index]!, {
        width: 512,
        height: 512,
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

  it("scrolls illustration thumbnails only after clicking a variant thumbnail", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.previewImages.length >= 4;
    });
    if (!illustrationTemplate) {
      throw new Error("Illustration template with four variants not found");
    }
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    const rect = ({
      left,
      right,
    }: {
      left: number;
      right: number;
    }): DOMRect => {
      return {
        x: left,
        y: 0,
        top: 0,
        left,
        right,
        bottom: 48,
        width: right - left,
        height: 48,
        toJSON: () => {
          return {};
        },
      };
    };
    const mockElementRect = (
      element: Element,
      bounds: { left: number; right: number },
    ) => {
      Object.defineProperty(element, "getBoundingClientRect", {
        configurable: true,
        value: () => {
          return rect(bounds);
        },
      });
    };
    const mockScrollLeft = (element: Element, value: number) => {
      Object.defineProperty(element, "scrollLeft", {
        configurable: true,
        value,
        writable: true,
      });
    };
    const mockScrollSize = (
      element: Element,
      {
        scrollWidth,
        clientWidth,
      }: { scrollWidth: number; clientWidth: number },
    ) => {
      Object.defineProperty(element, "scrollWidth", {
        configurable: true,
        value: scrollWidth,
      });
      Object.defineProperty(element, "clientWidth", {
        configurable: true,
        value: clientWidth,
      });
    };
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
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
      if (index === 0 && illustrationTemplate.cardPreviewImage) {
        return r2ImageTransformUrl(illustrationTemplate.cardPreviewImage, {
          width: 512,
          height: 512,
          quality: 72,
        });
      }
      return r2ImageTransformUrl(illustrationTemplate.previewImages[index]!, {
        width: 512,
        height: 512,
        quality: 72,
      });
    };
    const lastIndex = illustrationTemplate.previewImages.length - 1;

    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();

    const card = screen.getByAltText(heroAlt).closest<HTMLElement>("div.group");
    if (!card) {
      throw new Error("Illustration card not found");
    }

    // Clicking the rightmost visible thumbnail reveals the next two thumbnails.
    const variant1Thumbnail = within(card).getByLabelText("Show variant 1");
    const variant2Thumbnail = within(card).getByLabelText("Show variant 2");
    const variant3Thumbnail = within(card).getByLabelText("Show variant 3");
    const variant4Thumbnail = within(card).getByLabelText("Show variant 4");
    const thumbnailStrip = variant2Thumbnail.parentElement;
    if (!thumbnailStrip) {
      throw new Error("Illustration thumbnail strip not found");
    }
    mockScrollLeft(thumbnailStrip, 0);
    mockScrollSize(thumbnailStrip, { scrollWidth: 240, clientWidth: 96 });
    mockElementRect(thumbnailStrip, { left: 0, right: 96 });
    mockElementRect(variant2Thumbnail, { left: 48, right: 96 });
    mockElementRect(variant3Thumbnail, { left: 104, right: 152 });
    mockElementRect(variant4Thumbnail, { left: 160, right: 208 });
    click(variant2Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 144 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the active thumbnail at the right edge still reveals the next
    // two thumbnails.
    scrollTo.mockClear();
    click(variant2Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(1));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 144 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Move to the last thumbnail without scrolling the thumbnail strip, then
    // click left to reveal the two thumbnails before the clicked one.
    scrollTo.mockClear();
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 190 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(2));
    });
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 190 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(3));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    mockScrollLeft(thumbnailStrip, 112);
    mockElementRect(variant1Thumbnail, { left: -96, right: -48 });
    mockElementRect(variant3Thumbnail, { left: 0, right: 48 });
    click(variant3Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(2));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the active thumbnail at the left edge still reveals the previous
    // two thumbnails.
    scrollTo.mockClear();
    click(variant3Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(2));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking near the left boundary scrolls all the way to the start.
    scrollTo.mockClear();
    mockScrollLeft(thumbnailStrip, 64);
    mockElementRect(variant1Thumbnail, { left: -16, right: 32 });
    click(variant1Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 0 });
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Switching away and back to Illustration remounts the active thumbnail but
    // must not scroll the dialog.
    scrollTo.mockClear();
    scrollIntoView.mockClear();
    click(tabByText("Presentation"));
    click(tabByText("Illustration"));
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the hero halves changes variants without scrolling thumbnails.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 10 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute(
        "src",
        heroSrc(lastIndex),
      );
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking the right half from the last variant wraps to the first one.
    fireEvent.click(screen.getByAltText(heroAlt), { clientX: 190 });
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(0));
    });
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Clicking near the right boundary scrolls all the way to the end.
    const remountedCard = screen
      .getByAltText(heroAlt)
      .closest<HTMLElement>("div.group");
    if (!remountedCard) {
      throw new Error("Remounted illustration card not found");
    }
    const remountedVariant4Thumbnail =
      within(remountedCard).getByLabelText("Show variant 4");
    const remountedThumbnailStrip = remountedVariant4Thumbnail.parentElement;
    if (!remountedThumbnailStrip) {
      throw new Error("Remounted illustration thumbnail strip not found");
    }
    scrollTo.mockClear();
    mockScrollLeft(remountedThumbnailStrip, 120);
    mockScrollSize(remountedThumbnailStrip, {
      scrollWidth: 240,
      clientWidth: 96,
    });
    mockElementRect(remountedThumbnailStrip, { left: 0, right: 96 });
    mockElementRect(remountedVariant4Thumbnail, { left: 48, right: 96 });
    click(remountedVariant4Thumbnail);
    await waitFor(() => {
      expect(screen.getByAltText(heroAlt)).toHaveAttribute("src", heroSrc(3));
    });
    expect(scrollTo).toHaveBeenCalledWith({ left: 144 });
    expect(scrollIntoView).not.toHaveBeenCalled();
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
        featureSwitches: {
          [FeatureSwitchKey.ChatTemplatePicker]: false,
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
        expect(
          screen.getByLabelText(`Select video template ${videoStyle.title}`),
        ).toBeInTheDocument();
        const posterUrl = r2ImageTransformUrl(
          videoStyle.cardPreviewImage ?? videoStyle.previewImage,
          {
            width: 480,
            height: 270,
          },
        );
        const previewVideo = document
          .querySelector(`source[src="${videoStyle.previewVideo}"]`)
          ?.closest("video");
        if (!(previewVideo instanceof HTMLVideoElement)) {
          throw new Error("Video template preview video not found");
        }
        const previewRoot = previewVideo.closest(
          "[data-video-template-preview]",
        );
        if (!previewRoot) {
          throw new Error("Video template preview root not found");
        }
        expect(
          previewRoot.querySelector("[data-video-template-poster]"),
        ).toHaveAttribute("src", posterUrl);
        expect(
          previewVideo.querySelector('source[type="video/webm; codecs=vp9"]'),
        ).toHaveAttribute("src", videoStyle.previewWebm);
        expect(previewVideo).toHaveAttribute("poster", posterUrl);
        expect(previewVideo).toHaveAttribute("preload", "none");
        expect(
          screen.getByLabelText(
            `Play video template preview ${videoStyle.title}`,
          ),
        ).toBeInTheDocument();
        expect(screen.queryByText("Presentation")).not.toBeInTheDocument();
        expect(screen.queryByText("Illustration")).not.toBeInTheDocument();
      });

      const previewVideo = document
        .querySelector(`source[src="${videoStyle.previewVideo}"]`)
        ?.closest("video");
      if (!(previewVideo instanceof HTMLVideoElement)) {
        throw new Error("Video template preview video not found");
      }
      const previewRoot = previewVideo.closest("[data-video-template-preview]");
      if (!previewRoot) {
        throw new Error("Video template preview root not found");
      }
      const previewPlayButton = screen.getByLabelText(
        `Play video template preview ${videoStyle.title}`,
      );
      fireEvent.click(previewPlayButton);
      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(previewVideo.defaultMuted).toBeTruthy();
      expect(previewVideo.muted).toBeTruthy();
      expect(previewVideo.preload).toBe("metadata");
      fireEvent.playing(previewVideo);
      expect(previewVideo.dataset.previewPlaying).toBe("true");

      previewVideo.currentTime = 3;
      fireEvent.mouseLeave(previewRoot);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(previewVideo.currentTime).toBe(0);
      expect(previewVideo.dataset.previewPlaying).toBe("false");

      fireEvent.mouseEnter(previewRoot);
      expect(playSpy).toHaveBeenCalledTimes(2);
      previewVideo.currentTime = 4;
      Object.defineProperty(previewVideo, "paused", {
        configurable: true,
        value: false,
      });
      fireEvent.click(previewPlayButton);
      expect(playSpy).toHaveBeenCalledTimes(2);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(previewVideo.currentTime).toBe(4);
    } finally {
      playSpy.mockRestore();
      pauseSpy.mockRestore();
    }
  });

  it("queues a selected template during an active run and clears the picker state", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
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
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
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
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
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
    const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
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
