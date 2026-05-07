/**
 * Regression test: composer model picker display matches outgoing send body.
 *
 * Bug history: when the thread had no per-run override
 * (chat_threads.selected_model = NULL) and the user did not touch the
 * picker, the picker trigger showed the org default model (e.g. "Claude
 * Sonnet 4.6") but the POST /api/zero/chat/messages body sent
 * `modelSelection: null`. The backend's resolveRunModelOverride wrote NULL
 * to chat_threads and fell through to the agent's own `selected_model`
 * (= claude-opus-4-7 on the Zero agent), NOT to the org default. Result:
 * user saw Sonnet, run executed on Opus.
 *
 * Fix: `chat-page` model-selection signals seed from the org default when
 * the user has not explicitly picked, so the picker's displayed model and
 * the request body's `modelSelection` always agree.
 *
 * Entry point: /chats/:id thread page
 * Mock (external): Web API via MSW (feature switch + org providers + thread
 *   row with null overrides + send-body capture).
 * Real (internal): chat-thread-page signals, composer, model-provider-picker.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  setMockOrgModelProviders,
  resetMockOrgModelProviders,
} from "../../../mocks/handlers/api-org-model-providers.ts";
import {
  setMockPersonalModelProviders,
  resetMockPersonalModelProviders,
} from "../../../mocks/handlers/api-personal-model-providers.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);
const THREAD_ID = "thread-test-1";
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

describe("chat composer — model picker display vs. send body", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockPersonalModelProviders();
  });

  // CHAT-MSEL-001: picker display and send body agree on org default
  it("sends the org default model in request body when user has not touched the picker", async () => {
    const user = userEvent.setup();

    const PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
    const DEFAULT_MODEL = "claude-sonnet-4-6";

    setMockFeatureSwitches({});
    setMockOrgModelProviders([
      {
        id: PROVIDER_ID,
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: DEFAULT_MODEL,
        needsReconnect: false,
        lastRefreshErrorCode: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);

    // Thread has no per-run override (chat_threads.{modelProviderId,selectedModel}=NULL).
    // mockChatLifecycle's chatThreadByIdContract.get response omits these
    // fields, which matches the null-override DB state in production.
    mockChatLifecycle({ threadId: THREAD_ID });

    // Override send handler to capture the outgoing body. mockChatLifecycle
    // registers its own send handler first; server.use() here takes priority.
    let capturedBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
        }
      | undefined;
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedBody = body;
        return respond(201, {
          runId: "run-test-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    // Trigger advertises the org default.
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
      ).toBeInTheDocument();
    });

    // Send without touching the picker.
    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });

    // The request carries the very model the picker was advertising, so the
    // backend persists it on chat_threads and the run executes on Sonnet.
    expect(capturedBody?.modelSelection).toStrictEqual({
      modelProviderId: PROVIDER_ID,
      selectedModel: DEFAULT_MODEL,
    });
  });

  it("sends the personal default when the agent prefers personal providers", async () => {
    const user = userEvent.setup();

    const AGENT_PROVIDER_ID = "00000000-0000-4000-a000-000000000011";
    const PERSONAL_PROVIDER_ID = "00000000-0000-4000-a000-000000000012";

    setMockFeatureSwitches({
      [FeatureSwitchKey.PersonalModelProvider]: true,
    });
    setMockOrgModelProviders([
      {
        id: AGENT_PROVIDER_ID,
        type: "anthropic-api-key",
        framework: "claude-code",
        secretName: "ANTHROPIC_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: "claude-opus-4-7",
        needsReconnect: false,
        lastRefreshErrorCode: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    setMockPersonalModelProviders([
      {
        id: PERSONAL_PROVIDER_ID,
        type: "openai-api-key",
        framework: "codex",
        secretName: "OPENAI_API_KEY",
        authMethod: null,
        secretNames: null,
        isDefault: true,
        selectedModel: "gpt-5.4",
        needsReconnect: false,
        lastRefreshErrorCode: null,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    server.use(
      mockApi(zeroAgentsByIdContract.get, ({ respond }) => {
        return respond(200, {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user-123",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [] as string[],
          modelProviderId: AGENT_PROVIDER_ID,
          selectedModel: "claude-opus-4-7",
          preferPersonalProvider: true,
        });
      }),
    );

    mockChatLifecycle({ threadId: THREAD_ID });

    let capturedBody:
      | {
          modelSelection?: {
            modelProviderId: string;
            selectedModel: string;
          } | null;
        }
      | undefined;
    server.use(
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedBody = body;
        return respond(201, {
          runId: "run-test-1",
          threadId: THREAD_ID,
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "gpt-5.4" }),
      ).toBeInTheDocument();
    });

    await sendMessageInUI(user, textarea, "Hello");

    await waitFor(() => {
      expect(capturedBody).toBeDefined();
    });

    expect(capturedBody?.modelSelection).toStrictEqual({
      modelProviderId: PERSONAL_PROVIDER_ID,
      selectedModel: "gpt-5.4",
    });
  });
});
