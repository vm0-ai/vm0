/**
 * Default model resolution tests for the chat composer.
 *
 * Covers the priority chain for what model name appears next to the Send
 * button on the chat composer:
 *
 *   thread override  >  agent default  >  org default
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

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  FeatureSwitchKey,
  chatMessagesContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  zeroAgentsByIdContract,
  zeroAgentInstructionsContract,
  type ModelProviderResponse,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  setMockFeatureSwitches,
  resetMockFeatureSwitches,
} from "../../../mocks/handlers/api-feature-switches.ts";
import {
  setMockOnboardingStatus,
  resetMockOnboardingStatus,
} from "../../../mocks/handlers/api-onboarding.ts";

const context = testContext();

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
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Seed three providers and mark one as the org default with the specified
 * selectedModel. This lets scenarios name agent/thread models from the
 * non-default providers without bumping into "that provider is the default"
 * ambiguity.
 */
function mockOrgProviders(options: {
  defaultProviderId:
    | typeof ANTHROPIC_PROVIDER_ID
    | typeof MOONSHOT_PROVIDER_ID
    | typeof ZAI_PROVIDER_ID;
  defaultSelectedModel: string;
}) {
  setMockOrgModelProviders([
    buildProvider({
      id: MOONSHOT_PROVIDER_ID,
      type: "moonshot-api-key",
      secretName: "MOONSHOT_API_KEY",
      isDefault: options.defaultProviderId === MOONSHOT_PROVIDER_ID,
      selectedModel:
        options.defaultProviderId === MOONSHOT_PROVIDER_ID
          ? options.defaultSelectedModel
          : "kimi-k2.5",
    }),
    buildProvider({
      id: ANTHROPIC_PROVIDER_ID,
      type: "anthropic-api-key",
      secretName: "ANTHROPIC_API_KEY",
      isDefault: options.defaultProviderId === ANTHROPIC_PROVIDER_ID,
      selectedModel:
        options.defaultProviderId === ANTHROPIC_PROVIDER_ID
          ? options.defaultSelectedModel
          : "claude-sonnet-4-6",
    }),
    buildProvider({
      id: ZAI_PROVIDER_ID,
      type: "zai-api-key",
      secretName: "ZAI_API_KEY",
      isDefault: options.defaultProviderId === ZAI_PROVIDER_ID,
      selectedModel:
        options.defaultProviderId === ZAI_PROVIDER_ID
          ? options.defaultSelectedModel
          : "glm-5.1",
    }),
  ]);
}

function mockThread(options: {
  modelProviderId: string | null;
  selectedModel: string | null;
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
      return respond(200, { messages: [] });
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

// Thread page composer renders the model as plain text (picker is locked
// once the thread has stored values). No combobox exists there.
async function expectThreadComposerShowsModel(
  displayName: string,
): Promise<void> {
  await waitFor(() => {
    expect(screen.getByLabelText(displayName).tagName).toBe("SPAN");
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
    resetMockFeatureSwitches();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({
      [FeatureSwitchKey.ModelProviderSelection]: true,
    });
    // Align onboarding default with the test agent so currentChatAgentId$
    // resolves deterministically to AGENT_ID on the /agents/:id/chat route.
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
  });

  // ---------------------------------------------------------------------------
  // Scenario 1 — org default flows through when the agent has no custom model
  // ---------------------------------------------------------------------------

  // CHAT-DM-001: Org default (Kimi K2.5) is shown next to Send on the
  // /agents/:id/chat composer when the agent has no model configured.
  it("shows the org default when the agent has no custom model (CHAT-DM-001)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Kimi K2.5");
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — agent default overrides org default
  // ---------------------------------------------------------------------------

  // CHAT-DM-002: When the agent is pinned to Opus 4.7, the composer shows
  // Opus 4.7 even though the org default is Kimi K2.5.
  it("shows the agent default when set (Opus 4.7 over org Kimi) (CHAT-DM-002)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Claude Opus 4.7");
  });

  // CHAT-DM-003: Updating the agent's model (e.g. from Opus 4.7 -> 4.6 via
  // the profile tab) flows through: mounting a fresh chat page against an
  // agent whose stored model is Opus 4.6 shows Opus 4.6. This pins the
  // "re-enter chat after editing profile" leg of the workflow.
  it("shows the updated agent default (Opus 4.6) after a profile edit (CHAT-DM-003)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-6",
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Claude Opus 4.6");
  });

  // CHAT-DM-004: When the agent is reset to "use org default" (both fields
  // null), the composer falls back to the org default.
  it("falls back to the org default when the agent clears its model (CHAT-DM-004)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Kimi K2.5");
  });

  // CHAT-DM-005: When org admin switches the org default (e.g. from Kimi
  // to Sonnet via the org manage page), mounting a fresh chat page with
  // the new default-provider state shows the new default.
  it("shows an updated org default (Sonnet) for agents on org default (CHAT-DM-005)", async () => {
    mockOrgProviders({
      defaultProviderId: ANTHROPIC_PROVIDER_ID,
      defaultSelectedModel: "claude-sonnet-4-6",
    });
    mockAgent({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });
    await expectAgentChatLoaded();

    await expectComposerShowsModel("Claude Sonnet 4.6");
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — thread override outranks both agent and org defaults
  // ---------------------------------------------------------------------------

  // CHAT-DM-006: A thread that was started with a user-picked model (GLM)
  // keeps showing that model on /chats/:id regardless of what the agent or
  // org defaults are.
  it("thread override (GLM-5.1) wins over agent and org defaults (CHAT-DM-006)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });
    mockThread({
      modelProviderId: ZAI_PROVIDER_ID,
      selectedModel: "glm-5.1",
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await expectThreadComposerShowsModel("GLM-5.1");
  });

  // CHAT-DM-007: When the thread has no override, the composer on the
  // thread page falls back to the agent default (same rule as on the
  // landing page) — ensuring the override chain is consistent across both
  // entry points.
  it("thread without override falls back to the agent default (CHAT-DM-007)", async () => {
    mockOrgProviders({
      defaultProviderId: MOONSHOT_PROVIDER_ID,
      defaultSelectedModel: "kimi-k2.5",
    });
    mockAgent({
      modelProviderId: ANTHROPIC_PROVIDER_ID,
      selectedModel: "claude-opus-4-7",
    });
    mockThread({ modelProviderId: null, selectedModel: null });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    // Thread has no stored values yet — picker remains interactive.
    await expectComposerShowsModel("Claude Opus 4.7");
  });
});
