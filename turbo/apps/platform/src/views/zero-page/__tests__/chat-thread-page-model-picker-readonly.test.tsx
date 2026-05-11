/**
 * Thread-page model picker read-only behaviour.
 *
 * Rule: once a chat thread has at least one user message the composer's model
 * picker becomes read-only. The provider must remain consistent within a
 * session. Threads with only assistant messages or no messages keep the picker
 * interactive.
 *
 * Entry point: /chats/:threadId thread page.
 * Mock (external): Web API via MSW (feature switch + org providers + thread
 *   messages via paginated endpoint).
 * Real (internal): routing, chat-thread-page signals, composer, picker.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  chatMessagesContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  setMockOnboardingStatus,
  resetMockOnboardingStatus,
} from "../../../mocks/handlers/api-onboarding.ts";
import { setMockUserModelPreference } from "../../../mocks/handlers/api-user-model-preference.ts";

const context = testContext();
const mockApi = createMockApi(context);

const PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "thread-readonly-1";

function makeThreadDetail(
  overrides: Partial<{
    modelProviderId: string | null;
    selectedModel: string | null;
  }> = {},
) {
  return {
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
    modelProviderId: null,
    selectedModel: null,
    ...overrides,
  };
}

function makeUserMessage(): PagedChatMessage {
  return {
    id: "msg-user-1",
    role: "user",
    content: "Hello",
    createdAt: "2026-03-10T00:01:00Z",
  };
}

function makeAssistantMessage(): PagedChatMessage {
  return {
    id: "msg-assistant-1",
    role: "assistant",
    content: "Hi there",
    createdAt: "2026-03-10T00:02:00Z",
  };
}

function setupMocks(
  messages: PagedChatMessage[],
  threadOverrides?: Parameters<typeof makeThreadDetail>[0],
) {
  server.use(
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, makeThreadDetail(threadOverrides));
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages });
    }),
    mockApi(chatMessagesContract.send, ({ respond }) => {
      return respond(201, {
        runId: "run-test-1",
        threadId: THREAD_ID,
        status: "pending",
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
  );
}

describe("chat thread page — model picker read-only", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({});
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
    setMockUserModelPreference({ selectedModel: null, updatedAt: null });
    setMockOrgModelProviders([
      {
        id: PROVIDER_ID,
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: "claude-sonnet-4-6",
        needsReconnect: false,
        lastRefreshErrorCode: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
  });

  // CHAT-LOCK-001: picker on a thread with a user message renders as plain
  // text — no combobox/button — so the provider cannot be switched mid-session.
  it("renders picker as plain text when thread has a user message (CHAT-LOCK-001)", async () => {
    setupMocks([makeUserMessage()]);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const label = await waitFor(() => {
      return screen.getByLabelText("Claude Sonnet 4.6");
    });
    expect(label.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("combobox", { name: "Claude Sonnet 4.6" }),
    ).toBeNull();
  });

  // CHAT-LOCK-002: assistant-only history keeps the picker interactive.
  it("keeps picker interactive when thread has only assistant messages (CHAT-LOCK-002)", async () => {
    setupMocks([makeAssistantMessage()]);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      return screen.getByRole("combobox", { name: /Claude Sonnet 4\.6/i });
    });
  });

  // CHAT-LOCK-003: model-first selection is a user preference on new threads,
  // but an already-started thread still keeps its own model locked.
  it("renders model-first picker as plain text when thread has a user message (CHAT-LOCK-003)", async () => {
    setMockFeatureSwitches({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });
    setMockUserModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    setupMocks([makeUserMessage()], {
      selectedModel: "glm-5.1",
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const label = await waitFor(() => {
      return screen.getByLabelText("GLM-5.1");
    });
    expect(label.tagName).toBe("SPAN");
    expect(screen.queryByRole("combobox", { name: "GLM-5.1" })).toBeNull();
  });

  // CHAT-LOCK-004: empty thread keeps the picker interactive.
  it("keeps picker interactive on empty thread (CHAT-LOCK-004)", async () => {
    setupMocks([]);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      return screen.getByRole("combobox", { name: /Claude Sonnet 4\.6/i });
    });
  });
});
