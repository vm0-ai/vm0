import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@vm0/api-contracts/contracts/connector-identity";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@vm0/core";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { expect } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { CODEX_FAST_MODE_LOCAL_DEFAULT_STORAGE_KEY } from "../../../signals/zero-page/codex-fast-local-default.ts";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { composerOverflowConnectorSlugs } from "../../../mocks/handlers/connector-catalog-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

export const context = testContext();

export const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

export const OTHER_AGENT_ID = "e0000000-0000-4000-a000-000000000011";

export const THREAD_ID = "b1000000-0000-4000-a000-000000000101";

export const SUGGESTED_THREAD_ID = "b1000000-0000-4000-a000-000000000102";

export const UNTITLED_THREAD_ID = "b1000000-0000-4000-a000-000000000103";

export const OTHER_AGENT_THREAD_ID = "b1000000-0000-4000-a000-000000000104";

const ANTHROPIC_PROVIDER_ID = "00000000-0000-4000-a000-000000000001";

export const MOONSHOT_PROVIDER_ID = "00000000-0000-4000-a000-000000000002";

const ZAI_PROVIDER_ID = "00000000-0000-4000-a000-000000000003";

export const {
  set$: setCodexFastModeDefaultStorageForTest$,
  clear$: clearCodexFastModeDefaultStorageForTest$,
} = localStorageSignals(CODEX_FAST_MODE_LOCAL_DEFAULT_STORAGE_KEY);

export function applyUserConnectorUpdate(
  current: readonly string[],
  body: {
    readonly enabledConnectorSlugs: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledConnectorSlugs]));
  }
  if (body.operation === "remove") {
    return current.filter((connectorSlug) => {
      return !body.enabledConnectorSlugs.includes(connectorSlug);
    });
  }
  return [...body.enabledConnectorSlugs];
}

const NOW = "2026-05-08T00:00:00.000Z";

export function expectTextBefore(firstText: string, secondText: string): void {
  const first = screen.getByText(firstText);
  const second = screen.getByText(secondText);
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

function queryTabByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("tab").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

export function tabByText(text: string): HTMLElement {
  const tab = queryTabByText(text);
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

export function linkByText(text: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

export function buttonContainingText(
  text: string,
  container: ParentNode = document.body,
) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim().includes(text);
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

export function presentationTemplateGridScrollContainer(): HTMLElement {
  const scrollContainer = screen
    .getByRole("dialog")
    .querySelector<HTMLElement>("[data-presentation-template-grid-scroll]");
  if (!scrollContainer) {
    throw new Error("Presentation template grid scroll container not found");
  }
  return scrollContainer;
}

export function mockNavigatorUserAgent(userAgent: string): () => void {
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

export function mockIPadOSNavigator(): () => void {
  const userAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
  const maxTouchPoints = Object.getOwnPropertyDescriptor(
    navigator,
    "maxTouchPoints",
  );
  Object.defineProperties(navigator, {
    userAgent: {
      configurable: true,
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) " +
        "AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    },
    platform: { configurable: true, value: "MacIntel" },
    maxTouchPoints: { configurable: true, value: 5 },
  });
  const restore = (
    property: "userAgent" | "platform" | "maxTouchPoints",
    descriptor: PropertyDescriptor | undefined,
  ) => {
    if (descriptor) {
      Object.defineProperty(navigator, property, descriptor);
    } else {
      delete (navigator as Partial<Record<typeof property, unknown>>)[property];
    }
  };
  return () => {
    restore("userAgent", userAgent);
    restore("platform", platform);
    restore("maxTouchPoints", maxTouchPoints);
  };
}

export function buildProvider(
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

export function buildModelPolicy(
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

export function mockOrgModelRoutes(defaultSelectedModel: string): void {
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

export function billingStatus(
  tier: string,
  modelCapabilities?: {
    readonly supportByok?: boolean;
    readonly restrictedVm0Models?: boolean;
  },
): BillingStatusResponse {
  return {
    tier,
    ...modelCapabilities,
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

export function mockBillingCapabilities(
  modelCapabilities: {
    readonly supportByok: boolean;
    readonly restrictedVm0Models: boolean;
  },
  tier = "pro",
): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus(tier, modelCapabilities));
  });
}

export function mockAgent(options?: {
  selectedModel?: string | null;
  modelProviderId?: string | null;
  includeOtherAgent?: boolean;
}): void {
  const agents = [
    {
      id: AGENT_ID,
      displayName: "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    ...(options?.includeOtherAgent
      ? [
          {
            id: OTHER_AGENT_ID,
            displayName: "Other Agent",
            description: null,
            sound: null,
            avatarUrl: null,
            headVersionId: "version_2",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ]
      : []),
  ];
  context.mocks.data.team(agents);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const isOtherAgent = params.id === OTHER_AGENT_ID;
    return respond(200, {
      agentId: params.id,
      ownerId: "test-user-123",
      displayName: isOtherAgent ? "Other Agent" : "Scout",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: isOtherAgent ? null : (options?.modelProviderId ?? null),
      selectedModel: isOtherAgent ? null : (options?.selectedModel ?? null),
      preferPersonalProvider: false,
    });
  });
  context.mocks.api(zeroAgentInstructionsContract.get, ({ respond }) => {
    return respond(200, { content: null, filename: null });
  });
}

export function mockThread(options?: {
  selectedModel?: string | null;
  activeRunIds?: string[];
  messages?: MockChatEventInput[];
}): void {
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: THREAD_ID,
          agentId: AGENT_ID,
          title: "My thread",
          sortAt: "2026-03-10T00:00:00Z",
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: options?.selectedModel ?? null,
          serviceTier: null,
          computerUseHostId: null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, {
      threadIds:
        options?.activeRunIds && options.activeRunIds.length > 0
          ? [THREAD_ID]
          : [],
    });
  });
  context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
    if (
      query.sinceSeqId ||
      query.beforeSeqId ||
      query.sinceId ||
      query.beforeId
    ) {
      return respond(200, { events: [] });
    }
    return respond(200, {
      events: normalizeMockChatEvents(options?.messages ?? []),
    });
  });
}

export function mockComposerThreadSnapshot(
  threads: readonly {
    readonly id: string;
    readonly agentId: string;
    readonly title: string | null;
  }[],
): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threads.map((thread, index) => {
        const timestamp = new Date(
          Date.parse("2026-03-10T00:00:00Z") + index * 1000,
        ).toISOString();
        return {
          ...thread,
          sortAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          pinnedAt: null,
          renamedAt: null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        };
      }),
      latestEventId: null,
      latestSeqId: null,
    });
  });
}

export function mockActiveTemplateThread(): void {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    chatEvents: [
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

export function mockConnectors(
  connectors: {
    connectorSlug: ConnectorSlug;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    oauthScopes?: string[];
  }[],
): void {
  context.mocks.data.connectors(
    connectors.map((connector): ConnectorResponse => {
      return {
        id: crypto.randomUUID(),
        slug: connector.connectorSlug,
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

export function mockManyConnectedConnectors(): void {
  mockConnectors([
    { connectorSlug: "github", externalUsername: "octocat" },
    { connectorSlug: "slack", externalUsername: "launch-team" },
    ...composerOverflowConnectorSlugs.map((connectorSlug) => {
      return { connectorSlug };
    }),
  ]);
}

export function mockAgentConnectorAuthorizations(
  initialConnectorSlugs: readonly string[],
): void {
  let enabledConnectorSlugs: string[] = [...initialConnectorSlugs];
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: enabledConnectorSlugs });
  });
  context.mocks.api(zeroUserConnectorsContract.update, ({ body, respond }) => {
    enabledConnectorSlugs = applyUserConnectorUpdate(
      enabledConnectorSlugs,
      body,
    );
    return respond(200, { enabledConnectorSlugs: enabledConnectorSlugs });
  });
}

export function trackTemplatePreviewImagePreloads(): {
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

export function mockImmediateIdleCallback(): () => void {
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

export async function findComposerModel(label: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const combobox = screen.getByRole("combobox", { name: label });
    expect(combobox).toBeInTheDocument();
    return combobox;
  });
}

export async function expectComposerModel(label: string): Promise<void> {
  await expect(findComposerModel(label)).resolves.toBeInTheDocument();
}

export async function openTemplatePicker(
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
  expect(screen.queryByLabelText("Search connectors")).toBeNull();
  await waitFor(() => {
    expect(screen.getByText(template.title)).toBeInTheDocument();
  });

  click(screen.getByLabelText(`Preview ${template.title} at current slide`));
  await waitFor(() => {
    expect(
      screen.getByTestId(`${template.title} detail HTML preview`),
    ).toBeInTheDocument();
  });
  expect(screen.getByLabelText("Select style Funfair")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByLabelText("Select style Award night")).toBeInTheDocument();

  await user.click(screen.getByLabelText(`Select template ${template.title}`));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Template")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

export async function selectTemplate(
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

export async function selectIllustrationTemplate(
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

export function chatClipboardHtml(payload: {
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

export function oversizedFile(name: string, type: string): File {
  const file = new File(["oversized"], name, { type });
  Object.defineProperty(file, "size", {
    configurable: true,
    value: 1024 * 1024 * 1024 + 1,
  });
  return file;
}

export function composerElementFrom(textarea: HTMLElement): HTMLElement {
  const composer = textarea.closest(".zero-composer");
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Composer element not found");
  }
  return composer;
}

// The slash-workflow composer renders a TipTap contenteditable instead of a
// textarea, so locate it directly rather than by placeholder.
export async function findComposerEditor(): Promise<HTMLElement> {
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

export async function expectTemplateAttachedToComposer(
  removeAriaLabel: string,
): Promise<void> {
  const editor = await findComposerEditor();
  const removeButton = screen.getByLabelText(removeAriaLabel);
  const attachment = removeButton.closest(
    "[data-composer-template-attachment]",
  );
  expect(attachment).toBeInTheDocument();
  expect(editor).toContainElement(attachment as HTMLElement);
}

export function placeCaretAfterText(root: HTMLElement, text: string): void {
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

export function workflowSummary({
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
    ownerUserId: "user-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    canManage: true,
    canPublish: false,
  };
}
