/**
 * Default model resolution tests for the chat composer.
 *
 * Covers the priority chain for what model name appears next to the Send
 * button on the chat composer:
 *
 *   thread override  >  user preference  >  workspace default
 *
 * Entry points: /agents/:agentId/chat (landing page) and /chats/:threadId
 * (thread page).
 *
 * Mock (external): Web API via MSW contract helpers (feature switches, org
 *   model providers, agent detail, thread detail).
 * Real (internal): routing, bootstrap, agent-chat-page / chat-thread-page
 *   setup commands, all ccstate signals, composer rendering.
 *
 * Each test mounts a fresh page — we do not stitch multiple navigations
 * into a single test, because re-entering a route within the same store
 * can reuse cached ccstate computed values (e.g. orgModelProviders$) and
 * obscure what is actually being asserted. Instead, each test sets up the
 * mock state it needs and mounts once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatMessagesContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
} from "@vm0/api-contracts/contracts/zero-agents";
import type {
  ModelProviderResponse,
  OrgModelPolicy,
} from "@vm0/api-contracts/contracts/model-providers";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { mockUploadSuccess } from "../../../mocks/upload-helpers.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  setMockPersonalModelProviders,
  resetMockPersonalModelProviders,
} from "../../../mocks/handlers/api-personal-model-providers.ts";
import {
  resetMockOrgModelPolicies,
  setMockOrgModelPolicies,
} from "../../../mocks/handlers/api-org-model-policies.ts";
import {
  resetMockUserModelPreference,
  setMockUserModelPreference,
} from "../../../mocks/handlers/api-user-model-preference.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  setMockOnboardingStatus,
  resetMockOnboardingStatus,
} from "../../../mocks/handlers/api-onboarding.ts";
import { PLACEHOLDER, sendMessageInUI } from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

const AGENT_ID = "e0000000-0000-4000-a000-000000000010";

const ANTHROPIC_PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const MOONSHOT_PROVIDER_ID = "00000000-0000-4000-a000-000000000002";
const ZAI_PROVIDER_ID = "00000000-0000-4000-a000-000000000003";

const THREAD_ID = "thread-default-model-1";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface AgentModelConfig {
  modelProviderId: string | null;
  selectedModel: string | null;
  preferPersonalProvider?: boolean;
}

function mockAgent(config: AgentModelConfig) {
  setMockTeam([
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
  server.use(
    mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
      return respond(200, {
        agentId: AGENT_ID,
        ownerId: "test-user-123",
        displayName: "Scout",
        description: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [] as string[],
        modelProviderId: config.modelProviderId,
        selectedModel: config.selectedModel,
        preferPersonalProvider: config.preferPersonalProvider ?? false,
      });
    }),
    mockApi(zeroAgentInstructionsContract.get, ({ respond }) => {
      return respond(200, { content: null, filename: null });
    }),
  );
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
  const { model, ...rest } = overrides;
  return {
    id: "00000000-0000-4000-a000-000000000101",
    model,
    modelLabel: "Claude Opus 4.7",
    isDefault: false,
    defaultProviderType: "claude-code-oauth-token",
    credentialScope: "member",
    modelProviderId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...rest,
  };
}

function buildMemberOauthPolicy(
  overrides: Partial<OrgModelPolicy> = {},
): OrgModelPolicy {
  return buildModelPolicy({
    model: "claude-opus-4-7",
    modelLabel: "Claude Opus 4.7",
    isDefault: true,
    defaultProviderType: "claude-code-oauth-token",
    credentialScope: "member",
    modelProviderId: null,
    ...overrides,
  });
}

/**
 * Seed providers plus model-first policies. Provider rows are never marked as
 * defaults; the workspace default lives on the policy for the selected model.
 */
function mockOrgProviders(options: { defaultSelectedModel: string }) {
  setMockOrgModelProviders([
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
  setMockOrgModelPolicies([
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000201",
      model: "kimi-k2.5",
      modelLabel: "Kimi K2.5",
      isDefault: options.defaultSelectedModel === "kimi-k2.5",
      defaultProviderType: "moonshot-api-key",
      credentialScope: "org",
      modelProviderId: MOONSHOT_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000202",
      model: "claude-sonnet-4-6",
      modelLabel: "Claude Sonnet 4.6",
      isDefault: options.defaultSelectedModel === "claude-sonnet-4-6",
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
      model: "claude-opus-4-6",
      modelLabel: "Claude Opus 4.6",
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: ANTHROPIC_PROVIDER_ID,
    }),
    buildModelPolicy({
      id: "00000000-0000-4000-a000-000000000205",
      model: "glm-5.1",
      modelLabel: "GLM-5.1",
      isDefault: options.defaultSelectedModel === "glm-5.1",
      defaultProviderType: "zai-api-key",
      credentialScope: "org",
      modelProviderId: ZAI_PROVIDER_ID,
    }),
  ]);
}

function mockThread(options: {
  modelProviderId: string | null;
  selectedModel: string | null;
  messages?: {
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  }[];
}) {
  server.use(
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: THREAD_ID,
        title: "My thread",
        agentId: AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        latestSessionProviderType: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
        modelProviderId: options.modelProviderId,
        selectedModel: options.selectedModel,
      });
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: options.messages ?? [] });
    }),
    mockApi(chatMessagesContract.send, ({ respond }) => {
      return respond(201, {
        runId: "run-1",
        threadId: THREAD_ID,
        status: "pending",
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

async function expectComposerShowsModel(displayName: string): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: displayName }),
    ).toBeInTheDocument();
  });
}

// Thread page composer shows stored model values in the editable picker once a
// user message exists.
async function expectThreadComposerShowsModel(
  displayName: string,
): Promise<void> {
  await waitFor(() => {
    expect(
      screen.getByRole("combobox", { name: displayName }),
    ).toBeInTheDocument();
  });
}

async function expectAgentChatLoaded(): Promise<void> {
  // The document title is set to the agent display name once
  // setupAgentChatPage$ has fetched agent data; waiting on it guarantees
  // the reactive signal chain that feeds the composer has resolved.
  await waitFor(() => {
    expect(document.title).toContain("Scout");
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat composer — default model resolution", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockPersonalModelProviders();
    resetMockOrgModelPolicies();
    resetMockUserModelPreference();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({});
    // Align onboarding default with the test agent so currentChatAgentId$
    // resolves deterministically to AGENT_ID on the /agents/:id/chat route.
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
  });

  // ---------------------------------------------------------------------------
  // Scenario 1 — workspace default flows through when no user preference exists
  // ---------------------------------------------------------------------------

  // CHAT-DM-001: Workspace default (Kimi K2.5) is shown next to Send on the
  // /agents/:id/chat composer when the user has no model preference.
  it("shows the workspace default when no user preference exists (CHAT-DM-001)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Kimi K2.5");
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — user preference overrides workspace default
  // ---------------------------------------------------------------------------

  // CHAT-DM-002: When the user preference is Opus 4.7, the composer shows
  // Opus 4.7 even though the workspace default is Kimi K2.5.
  it("shows the user preference when set (Opus 4.7 over workspace Kimi) (CHAT-DM-002)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "kimi-k2.5",
    });
    setMockUserModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent({
      modelProviderId: null,
      selectedModel: null,
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Claude Opus 4.7");
  });

  it("blocks agent chat submit and opens Claude Code OAuth token input from the model warning", async () => {
    const user = userEvent.setup();
    let sendRequests = 0;
    setMockFeatureSwitches({});
    setMockOrgModelPolicies([buildMemberOauthPolicy()]);
    setMockPersonalModelProviders([]);
    mockAgent({ modelProviderId: null, selectedModel: null });
    server.use(
      mockApi(chatMessagesContract.send, ({ respond }) => {
        sendRequests++;
        return respond(201, {
          runId: "run-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();
    await expectComposerShowsModel("Claude Opus 4.7");

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(textarea, "Hello");
    await user.keyboard("{Enter}");

    const sendButton = screen.getByLabelText("Send");
    expect(sendButton).toBeDisabled();
    expect(sendRequests).toBe(0);
    expect(screen.queryByText(/This workspace routes/)).not.toBeInTheDocument();

    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      /Model Configure: This workspace routes Claude Opus 4\.7/,
    );
    const modelTrigger = screen.getByRole("combobox", {
      name: "Claude Opus 4.7",
    });
    expect(
      warning.compareDocumentPosition(modelTrigger) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.click(warning);
    await expect(
      screen.findByText("Configure Claude Code OAuth"),
    ).resolves.toBeInTheDocument();
    await fill(screen.getByPlaceholderText("sk-ant-XXXXXXX"), "oauth-token");
    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).not.toBeDisabled();
    });
  });

  it("blocks agent chat submit and opens ChatGPT auth.json paste from the model warning", async () => {
    const user = userEvent.setup();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);
    let sendRequests = 0;
    setMockFeatureSwitches({});
    setMockOrgModelPolicies([
      buildMemberOauthPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT-5.5",
        defaultProviderType: "codex-oauth-token",
      }),
    ]);
    setMockPersonalModelProviders([]);
    mockAgent({ modelProviderId: null, selectedModel: null });
    server.use(
      mockApi(chatMessagesContract.send, ({ respond }) => {
        sendRequests++;
        return respond(201, {
          runId: "run-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();
    await expectComposerShowsModel("GPT-5.5");

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(textarea, "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    expect(sendRequests).toBe(0);

    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      /Model Configure: This workspace routes GPT-5\.5/,
    );
    await user.click(warning);

    await expect(
      screen.findByTestId("codex-paste-textarea"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Connect Codex")).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  // CHAT-DM-003: Updating the user's model preference flows through: mounting
  // a fresh chat page after the preference changes shows the new model.
  it("shows the updated user preference (Opus 4.6) (CHAT-DM-003)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "kimi-k2.5",
    });
    setMockUserModelPreference({
      selectedModel: "claude-opus-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent({
      modelProviderId: null,
      selectedModel: "claude-opus-4-7",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Claude Opus 4.6");
  });

  it("blocks thread submit and opens ChatGPT auth.json paste from the model warning", async () => {
    const user = userEvent.setup();
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);
    let sendRequests = 0;
    setMockFeatureSwitches({});
    setMockOrgModelPolicies([
      buildMemberOauthPolicy({
        model: "gpt-5.5",
        modelLabel: "GPT-5.5",
        defaultProviderType: "codex-oauth-token",
      }),
    ]);
    setMockPersonalModelProviders([]);
    mockAgent({ modelProviderId: null, selectedModel: null });
    mockThread({ modelProviderId: null, selectedModel: null });
    server.use(
      mockApi(chatMessagesContract.send, ({ respond }) => {
        sendRequests++;
        return respond(201, {
          runId: "run-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });
    await expectComposerShowsModel("GPT-5.5");

    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await fill(textarea, "Hello");
    await user.keyboard("{Enter}");

    expect(screen.getByLabelText("Send")).toBeDisabled();
    expect(sendRequests).toBe(0);

    const warning = (await screen.findByText("Model Configure")).closest(
      "button",
    )!;
    expect(warning).toHaveAccessibleName(
      /Model Configure: This workspace routes GPT-5\.5/,
    );
    await user.click(warning);

    await expect(
      screen.findByTestId("codex-paste-textarea"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("Connect Codex")).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  // CHAT-DM-004: When the user has no model preference, the composer falls
  // back to the workspace default.
  it("falls back to the workspace default when the user has no model preference (CHAT-DM-004)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Kimi K2.5");
  });

  // CHAT-DM-005: When org admin switches the workspace default (e.g. from Kimi
  // to Sonnet via the org manage page), mounting a fresh chat page with
  // the new default-provider state shows the new default.
  it("shows an updated workspace default (Sonnet) when no user preference exists (CHAT-DM-005)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "claude-sonnet-4-6",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Claude Sonnet 4.6");
  });

  it("blocks visual attachments on a text-only model but allows other files", async () => {
    const user = userEvent.setup();
    mockOrgProviders({
      defaultSelectedModel: "glm-5.1",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();
    server.use(
      ...mockUploadSuccess({
        id: "notes-upload",
        filename: "notes.txt",
        contentType: "text/plain",
        size: 12,
        url: "https://example.com/notes.txt",
      }),
    );

    await expectComposerShowsModel("GLM-5.1");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const attachButton = screen.getByLabelText("Attach");
    expect(attachButton).not.toBeDisabled();

    await user.upload(
      fileInput,
      new File(["image"], "screenshot.png", { type: "image/png" }),
    );
    await expect(
      screen.findAllByText(/GLM-5\.1 cannot recognize images or videos/i),
    ).resolves.not.toHaveLength(0);

    await user.upload(
      fileInput,
      new File(["plain text"], "notes.txt", { type: "text/plain" }),
    );
    await expect(
      screen.findByLabelText("Remove notes.txt"),
    ).resolves.toBeInTheDocument();
  });

  it("filters existing visual attachments while a text-only model is selected", async () => {
    const user = userEvent.setup();
    mockOrgProviders({
      defaultSelectedModel: "claude-sonnet-4-6",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });
    server.use(
      ...mockUploadSuccess({
        id: "screenshot-upload",
        filename: "screenshot.png",
        contentType: "image/png",
        size: 12,
        url: "https://example.com/screenshot.png",
      }),
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();
    await expectComposerShowsModel("Claude Sonnet 4.6");

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "screenshot.png", { type: "image/png" }),
    );
    await expect(
      screen.findByLabelText("Open image preview for screenshot.png"),
    ).resolves.toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );
    await user.click(await screen.findByRole("option", { name: /GLM-5\.1/ }));

    await expectComposerShowsModel("GLM-5.1");
    await expect(
      screen.findAllByText(/GLM-5\.1 cannot recognize images or videos/i),
    ).resolves.not.toHaveLength(0);
    await waitFor(() => {
      expect(
        screen.queryByLabelText("Open image preview for screenshot.png"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText("Remove screenshot.png"),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeDisabled();
    });

    await user.click(screen.getByRole("combobox", { name: "GLM-5.1" }));
    await user.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4\.6/ }),
    );

    await expectComposerShowsModel("Claude Sonnet 4.6");
    await expect(
      screen.findByLabelText("Open image preview for screenshot.png"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Send")).not.toBeDisabled();
  });

  it("filters visual attachments from submit on a text-only model", async () => {
    const user = userEvent.setup();
    let capturedAttachFiles: unknown = "not-called";
    mockOrgProviders({
      defaultSelectedModel: "claude-sonnet-4-6",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });
    mockThread({ modelProviderId: null, selectedModel: null });
    server.use(
      ...mockUploadSuccess({
        id: "screenshot-upload",
        filename: "screenshot.png",
        contentType: "image/png",
        size: 12,
        url: "https://example.com/screenshot.png",
      }),
    );
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedAttachFiles = body.attachFiles;
        return respond(201, {
          runId: "run-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });
    await expectComposerShowsModel("Claude Sonnet 4.6");

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "screenshot.png", { type: "image/png" }),
    );
    await expect(
      screen.findByLabelText("Open image preview for screenshot.png"),
    ).resolves.toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
    );
    await user.click(await screen.findByRole("option", { name: /GLM-5\.1/ }));
    await expectComposerShowsModel("GLM-5.1");

    const textarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Please review");

    await waitFor(() => {
      expect(capturedAttachFiles).toBeUndefined();
    });
  });

  it("filters visual attachments from submit when inheriting a text-only default model", async () => {
    const user = userEvent.setup();
    let capturedAttachFiles: unknown = "not-called";
    mockOrgProviders({
      defaultSelectedModel: "glm-5.1",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });
    server.use(
      ...mockUploadSuccess({
        id: "screenshot-upload",
        filename: "screenshot.png",
        contentType: "image/png",
        size: 12,
        url: "https://example.com/screenshot.png",
      }),
    );
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedAttachFiles = body.attachFiles;
        return respond(201, {
          runId: "run-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();
    await expectComposerShowsModel("GLM-5.1");

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "screenshot.png", { type: "image/png" }),
    );
    await expect(
      screen.findAllByText(/GLM-5\.1 cannot recognize images or videos/i),
    ).resolves.not.toHaveLength(0);

    const textarea = screen.getByPlaceholderText(
      PLACEHOLDER,
    ) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Please review");

    await waitFor(() => {
      expect(capturedAttachFiles).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — thread override outranks user and workspace defaults
  // ---------------------------------------------------------------------------

  // CHAT-DM-006: A thread that was started with a user-picked model (GLM)
  // keeps showing that model on /chats/:id regardless of user/workspace
  // defaults.
  it("thread override (GLM-5.1) wins over user and workspace defaults (CHAT-DM-006)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "kimi-k2.5",
    });
    setMockUserModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent({
      modelProviderId: null,
      selectedModel: "claude-opus-4-7",
    });
    mockThread({
      modelProviderId: null,
      selectedModel: "glm-5.1",
      messages: [
        {
          id: "msg-user-1",
          role: "user" as const,
          content: "Use GLM",
          createdAt: "2026-03-10T00:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expectThreadComposerShowsModel("GLM-5.1");
  });

  // CHAT-DM-007: When the thread has no override, the composer on the thread
  // page falls back to the user preference — ensuring the override chain is
  // consistent across both entry points.
  it("thread without override falls back to the user preference (CHAT-DM-007)", async () => {
    mockOrgProviders({
      defaultSelectedModel: "kimi-k2.5",
    });
    setMockUserModelPreference({
      selectedModel: "claude-opus-4-7",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockAgent({
      modelProviderId: null,
      selectedModel: "glm-5.1",
    });
    mockThread({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    // Thread has no stored values yet — picker remains interactive.
    await expectComposerShowsModel("Claude Opus 4.7");
  });
});
