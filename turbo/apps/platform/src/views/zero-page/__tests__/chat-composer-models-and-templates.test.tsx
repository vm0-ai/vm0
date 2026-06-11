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
  VIDEO_STYLE_PRESETS,
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
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { beforeEach, describe, expect, it } from "vitest";
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

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
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
      model: "kimi-k2.5",
      modelLabel: "Kimi K2.5",
      isDefault: defaultSelectedModel === "kimi-k2.5",
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
      customSkills: [],
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
      latestSessionId: null,
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
        status: "running",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
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

async function expectComposerModel(label: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: label })).toBeInTheDocument();
  });
}

async function openTemplatePicker(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
  const slideCount =
    template.previewImages.length > 0 ? template.previewImages.length : 1;

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

  if (slideCount > 1) {
    const previewImage = screen.getByTitle(
      `${template.title} card preview slide 1`,
    );
    const preview = previewImage.parentElement;
    if (!preview) {
      throw new Error("Template preview not found");
    }
    Object.defineProperty(preview, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        return new DOMRect(0, 0, 300, 160);
      },
    });
    fireEvent.mouseMove(preview, { clientX: 300, clientY: 80 });
    await waitFor(() => {
      expect(
        screen.getByTitle(`${template.title} card preview slide ${slideCount}`),
      ).toBeInTheDocument();
    });
    fireEvent.mouseLeave(preview);
  }

  click(screen.getByLabelText(`View template ${template.title}`));
  await waitFor(() => {
    expect(screen.getByText(`1 of ${slideCount}`)).toBeInTheDocument();
  });

  if (slideCount > 1) {
    click(screen.getByLabelText("Next slide"));
    await waitFor(() => {
      expect(screen.getByText(`2 of ${slideCount}`)).toBeInTheDocument();
    });
    click(screen.getByLabelText("Previous slide"));
    await waitFor(() => {
      expect(screen.getByText(`1 of ${slideCount}`)).toBeInTheDocument();
    });
    click(screen.getByLabelText("Show slide 2"));
    await waitFor(() => {
      expect(screen.getByText(`2 of ${slideCount}`)).toBeInTheDocument();
    });
  }

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
  template: (typeof PRESENTATION_TEMPLATE_ITEMS)[number],
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

function templateLabel(
  item: (typeof PRESENTATION_TEMPLATE_ITEMS)[number],
): string {
  const label = item.templateId
    .replace(/^template:/, "")
    .replace(/^html-ppt-/, "")
    .replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
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

beforeEach(() => {
  context.mocks.data.onboardingStatus({ defaultAgentId: AGENT_ID });
});

describe("chat composer models", () => {
  it("resolves workspace, user, and thread model choices in the visible picker", async () => {
    mockOrgModelRoutes("kimi-k2.5");
    mockAgent();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(document.title).toContain("Scout");
    });
    await expectComposerModel("Kimi K2.5");
  });

  it("shows user preference over workspace default", async () => {
    mockOrgModelRoutes("kimi-k2.5");
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
    mockOrgModelRoutes("kimi-k2.5");
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
        model: "kimi-k2.6",
        modelLabel: "Kimi K2.6",
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
        screen.getByRole("option", { name: /Kimi K2\.6 BYOK/ }),
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

    await user.click(screen.getByLabelText("Remove GitHub"));

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
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    await openTemplatePicker(user);

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Remove template ${templateLabel(template)}`),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText(`Remove template ${templateLabel(template)}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove template ${templateLabel(template)}`),
      ).not.toBeInTheDocument();
    });
  });

  it("selects and removes an illustration style from the picker", async () => {
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
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

    await waitFor(() => {
      expect(screen.getByText("VM0 illustration styles")).toBeInTheDocument();
      expect(screen.getByText(illustrationTemplate.title)).toBeInTheDocument();
      expect(
        screen.getByTitle(`${illustrationTemplate.title} illustration preview`),
      ).toHaveAttribute("src", illustrationTemplate.previewImage);
      expect(screen.getAllByTitle(/ illustration preview$/u)).toHaveLength(
        ILLUSTRATION_TEMPLATE_ITEMS.length,
      );
    });

    click(screen.getByLabelText(`View template ${illustrationTemplate.title}`));
    await waitFor(() => {
      expect(
        screen.getByTitle(`${illustrationTemplate.title} preview variant 1`),
      ).toBeInTheDocument();
    });
    click(screen.getByLabelText("Show variant 2"));
    await waitFor(() => {
      expect(
        screen.getByTitle(`${illustrationTemplate.title} preview variant 2`),
      ).toBeInTheDocument();
    });
    click(screen.getByLabelText("Show variant 1"));
    await waitFor(() => {
      expect(
        screen.getByTitle(`${illustrationTemplate.title} preview variant 1`),
      ).toBeInTheDocument();
    });
    click(buttonByText("Templates"));
    await waitFor(() => {
      expect(screen.getByText("VM0 illustration styles")).toBeInTheDocument();
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
        screen.queryByLabelText(`Remove template ${templateLabel(template)}`),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps newer template selections visible after a queued template is sent", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const nextTemplate = PRESENTATION_TEMPLATE_ITEMS[1]!;
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

    await selectTemplate(user, nextTemplate);

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove template ${templateLabel(nextTemplate)}`),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText(`Remove template ${templateLabel(template)}`),
      ).not.toBeInTheDocument();
    });
  });

  it("selects and removes a video style from the picker", async () => {
    const videoStyle = VIDEO_STYLE_PRESETS.find((item) => {
      return item.nameEn === "Phone Product Showcase";
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
      expect(screen.getByText("VM0 video styles")).toBeInTheDocument();
    });

    click(buttonByText("Brand & Commercial"));
    await waitFor(() => {
      expect(
        screen.getByLabelText(`Select video style ${videoStyle.nameEn}`),
      ).toBeInTheDocument();
      expect(screen.queryByText("Symmetrical Pastel Quirky")).toBeNull();
    });

    await fill(screen.getByLabelText("Search templates"), "no matching style");
    await waitFor(() => {
      expect(screen.getByText("No matches")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Search templates"), "phone");
    click(screen.getByLabelText(`Select video style ${videoStyle.nameEn}`));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.getByLabelText(`Remove video style ${videoStyle.nameEn}`),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText(`Remove video style ${videoStyle.nameEn}`));

    await waitFor(() => {
      expect(screen.getByLabelText("Template")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        screen.queryByLabelText(`Remove video style ${videoStyle.nameEn}`),
      ).not.toBeInTheDocument();
    });
  });
});
