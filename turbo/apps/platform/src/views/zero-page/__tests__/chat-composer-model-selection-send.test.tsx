/**
 * Regression test: inherited model-first composer sends inherit intent.
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
 * Model-first uses `modelSelection: null` to mean "inherit"; the backend
 * resolves that against the thread/agent/user/org model policy chain.
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
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);
const THREAD_ID = "thread-test-1";

describe("chat composer — model picker display vs. send body", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
  });

  // CHAT-MSEL-001: picker display uses inherited org default while the send
  // body preserves inherit semantics.
  it("sends null modelSelection when user has not touched the model-first picker", async () => {
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

    expect(capturedBody?.modelSelection).toBeNull();
  });
});
