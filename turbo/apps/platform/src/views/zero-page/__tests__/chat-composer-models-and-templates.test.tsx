import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { PRESENTATION_TEMPLATE_ITEMS } from "@vm0/core";
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
import { zeroClaudeCodeDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import { zeroCodexDeviceAuthContract } from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { beforeEach, describe, expect, it } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
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

async function expectComposerModel(label: string): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("combobox", { name: label })).toBeInTheDocument();
  });
}

async function openTemplatePicker(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  click(
    await waitFor(() => {
      return screen.getByLabelText("Template");
    }),
  );
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  await user.click(
    screen.getByLabelText(
      `Select template ${PRESENTATION_TEMPLATE_ITEMS[0]!.title}`,
    ),
  );
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
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    const openWindow = context.mocks.browser.open(authWindow);
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
      /Model Configure: This workspace routes GPT-5\.5/,
    );

    await user.click(warning);

    await expect(
      screen.findByTestId("codex-device-auth-code"),
    ).resolves.toHaveTextContent("ABCD-EFGH");
    expect(screen.getByText("Connect Codex")).toBeInTheDocument();
    expect(openWindow.calls).toStrictEqual([]);
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
  });
});

describe("chat composer templates", () => {
  it("queues a selected template during an active run and keeps newer selections visible", async () => {
    const user = userEvent.setup({ delay: null });
    const template = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const nextTemplate = PRESENTATION_TEMPLATE_ITEMS[1]!;
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatTemplatePicker]: true },
    });

    const firstTextarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await sendMessageInUI(
      user,
      firstTextarea as HTMLTextAreaElement,
      "Start an active deck run",
    );
    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await openTemplatePicker(user);
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
    });

    click(await screen.findByLabelText("Template"));
    await user.click(
      screen.getByLabelText(`Select template ${nextTemplate.title}`),
    );

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
});
