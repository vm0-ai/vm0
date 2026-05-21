/**
 * Thread-page model picker model-first behaviour.
 *
 * Rule: the composer's model picker remains editable in an existing chat
 * thread. Switching away from the thread-pinned model sends forceNewSession so
 * the backend starts a compatible CLI session.
 *
 * Entry point: /chats/:threadId thread page.
 * Mock (external): Web API via MSW (feature switch + org providers + thread
 *   messages via paginated endpoint).
 * Real (internal): routing, chat-thread-page signals, composer, picker.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { PLACEHOLDER, sendMessageInUI } from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

const PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "thread-editable-1";

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

describe("chat thread page — model picker editable", () => {
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

  // CHAT-MODEL-EDIT-001: once a user turn exists, the model can still be
  // changed from the thread composer.
  it("keeps picker interactive when thread has a user message (CHAT-MODEL-EDIT-001)", async () => {
    setupMocks([makeUserMessage()]);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      return screen.getByRole("combobox", { name: /DeepSeek V4 Pro/i });
    });
  });

  // CHAT-MODEL-EDIT-002: assistant-only history keeps the picker interactive.
  it("keeps picker interactive when thread has only assistant messages (CHAT-MODEL-EDIT-002)", async () => {
    setupMocks([makeAssistantMessage()]);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      return screen.getByRole("combobox", { name: /DeepSeek V4 Pro/i });
    });
  });

  // CHAT-MODEL-EDIT-003: thread-pinned model wins the initial display over the
  // user's current model preference and remains editable once a user message exists.
  it("shows the thread-pinned model in an editable picker when the thread has a user message (CHAT-MODEL-EDIT-003)", async () => {
    setMockUserModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    setupMocks([makeUserMessage()], {
      selectedModel: "glm-5.1",
    });

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const trigger = await waitFor(() => {
      return screen.getByRole("combobox", { name: /GLM-5\.1/i });
    });
    const icon = trigger.querySelector("img");
    expect(icon?.getAttribute("src")).toContain("chatglm.svg");
    expect(icon).toHaveClass("zero-icon-mono");
  });

  // CHAT-MODEL-EDIT-004: empty thread keeps the picker interactive.
  it("keeps picker interactive on empty thread (CHAT-MODEL-EDIT-004)", async () => {
    setupMocks([]);

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await waitFor(() => {
      return screen.getByRole("combobox", { name: /DeepSeek V4 Pro/i });
    });
  });

  // CHAT-MODEL-EDIT-005: changing the model on an existing thread sends the
  // forceNewSession flag expected by the backend model-switch path.
  it("sends forceNewSession when changing model on an existing thread (CHAT-MODEL-EDIT-005)", async () => {
    const user = userEvent.setup();
    let capturedBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
          forceNewSession?: boolean;
        }
      | undefined;

    setupMocks([makeUserMessage()], {
      selectedModel: "claude-sonnet-4-6",
    });
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedBody = {
          modelSelection:
            "modelSelection" in body ? body.modelSelection : undefined,
          forceNewSession:
            "forceNewSession" in body ? body.forceNewSession : undefined,
        };
        return respond(201, {
          runId: "run-test-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await user.click(
      await screen.findByRole("combobox", { name: /Claude Sonnet 4\.6/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Claude Opus 4\.7/i }),
    );
    const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
    await sendMessageInUI(
      user,
      textarea as HTMLTextAreaElement,
      "Use Opus now",
    );

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    expect(capturedBody?.modelSelection?.selectedModel).toBe("claude-opus-4-7");
    expect(capturedBody?.forceNewSession).toBeTruthy();
  });
});
