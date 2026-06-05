/**
 * Thread-page model picker model-first behaviour.
 *
 * Rule: the composer's model picker remains editable in an existing chat
 * thread. Changing it writes the thread model pin immediately, and switching
 * away from the previous thread-pinned model sends forceNewSession so the
 * backend starts a compatible CLI session.
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
  chatThreadModelSelectionContract,
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
const FIXTURE_RUN_ID = "run-history-1";

function makeThreadDetail(
  overrides: Partial<{
    activeRunIds: string[];
    modelProviderId: string | null;
    selectedModel: string | null;
  }> = {},
) {
  return {
    id: THREAD_ID,
    title: "My thread",
    agentId: AGENT_ID,
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
    runId: FIXTURE_RUN_ID,
    createdAt: "2026-03-10T00:01:00Z",
  };
}

function makeAssistantMessage(): PagedChatMessage {
  return {
    id: "msg-assistant-1",
    role: "assistant",
    content: "Hi there",
    runId: FIXTURE_RUN_ID,
    createdAt: "2026-03-10T00:02:00Z",
  };
}

function makeCompletionMarker(): PagedChatMessage {
  return {
    id: "msg-marker-1",
    role: "assistant",
    content: null,
    runId: FIXTURE_RUN_ID,
    runLifecycleEvent: "completed",
    createdAt: "2026-03-10T00:03:00Z",
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
    setupMocks([makeUserMessage(), makeCompletionMarker()], {
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

  // CHAT-MODEL-EDIT-005: changing the model on an existing thread persists the
  // thread pin and sends the forceNewSession flag expected by the backend
  // model-switch path.
  it("updates the thread model and sends forceNewSession when changing model on an existing thread (CHAT-MODEL-EDIT-005)", async () => {
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
    let capturedModelSelectionBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
        }
      | undefined;

    setupMocks([makeUserMessage(), makeCompletionMarker()], {
      selectedModel: "claude-sonnet-4-6",
    });
    server.use(
      mockApi(chatThreadModelSelectionContract.update, ({ body, respond }) => {
        capturedModelSelectionBody = body;
        return respond(204);
      }),
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
      await screen.findByRole("option", { name: /Claude Opus 4\.8/i }),
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
    expect(capturedModelSelectionBody?.modelSelection?.selectedModel).toBe(
      "claude-opus-4-8",
    );
    expect(capturedBody?.modelSelection?.selectedModel).toBe("claude-opus-4-8");
    expect(capturedBody?.forceNewSession).toBeTruthy();
  });

  // CHAT-MODEL-EDIT-006: queued sends share the same model-switch semantics as
  // direct sends so the backend can start a compatible CLI session.
  it("sends forceNewSession for queued messages after changing model on an active thread (CHAT-MODEL-EDIT-006)", async () => {
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
    let capturedModelSelectionBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
        }
      | undefined;

    const activeUserMessage: PagedChatMessage = {
      id: "msg-active-user-1",
      role: "user",
      content: "still running",
      runId: "run-active-1",
      createdAt: "2026-03-10T00:04:00Z",
    };
    setupMocks([makeUserMessage(), makeCompletionMarker(), activeUserMessage], {
      activeRunIds: ["run-active-1"],
      selectedModel: "claude-sonnet-4-6",
    });
    server.use(
      mockApi(chatThreadModelSelectionContract.update, ({ body, respond }) => {
        capturedModelSelectionBody = body;
        return respond(204);
      }),
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedBody = {
          modelSelection:
            "modelSelection" in body ? body.modelSelection : undefined,
          forceNewSession:
            "forceNewSession" in body ? body.forceNewSession : undefined,
        };
        return respond(201, {
          runId: null,
          threadId: THREAD_ID,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    await user.click(
      await screen.findByRole("combobox", { name: /Claude Sonnet 4\.6/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /Claude Opus 4\.8/i }),
    );
    const textarea = await screen.findByPlaceholderText(
      /Type your next message/,
    );
    await sendMessageInUI(
      user,
      textarea as HTMLTextAreaElement,
      "Queue this on Opus",
    );

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });
    expect(capturedModelSelectionBody?.modelSelection?.selectedModel).toBe(
      "claude-opus-4-8",
    );
    expect(capturedBody?.modelSelection?.selectedModel).toBe("claude-opus-4-8");
    expect(capturedBody?.forceNewSession).toBeTruthy();
  });
});
