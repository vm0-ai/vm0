/**
 * Thread-page model picker is read-only.
 *
 * Rule: once a chat thread has been sent (modelProviderId + selectedModel
 * persisted on the row), the composer's model picker becomes read-only. The
 * user cannot change the thread's model — the backend also enforces this,
 * see route.test.ts.
 *
 * Entry point: /chats/:threadId thread page.
 * Mock (external): Web API via MSW (feature switch + org providers + thread
 *   row with stored overrides).
 * Real (internal): routing, chat-thread-page signals, composer, picker.
 *
 * The parallel "picker is enabled on /agents/:id/chat" case is covered by
 * chat-default-model-resolution.test.tsx and chat-composer-model-selection-send.test.tsx
 * (both mount the landing page and interact with the picker), so we only
 * need to prove the lock is applied on the thread page here.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  FeatureSwitchKey,
  chatMessagesContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
} from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
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

const PROVIDER_ID = "00000000-0000-4000-a000-000000000001";
const STORED_MODEL = "claude-opus-4-7";
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "thread-readonly-1";

describe("chat thread page — model picker is read-only on existing threads", () => {
  beforeEach(() => {
    resetMockOrgModelProviders();
    resetMockFeatureSwitches();
    resetMockOnboardingStatus();
    setMockFeatureSwitches({
      [FeatureSwitchKey.ModelProviderSelection]: true,
    });
    setMockOnboardingStatus({ defaultAgentId: AGENT_ID });
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
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
  });

  // CHAT-LOCK-001: picker on an existing thread renders as plain text — no
  // combobox/button — so the user cannot switch models mid-thread.
  it("renders the picker as plain text on /chats/:threadId when the thread has stored values (CHAT-LOCK-001)", async () => {
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
          modelProviderId: PROVIDER_ID,
          selectedModel: STORED_MODEL,
        });
      }),
      mockApi(chatThreadMessagesContract.list, ({ respond }) => {
        return respond(200, { messages: [] });
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

    detachedSetupPage({ context, path: `/chats/${THREAD_ID}` });

    const label = await waitFor(() => {
      return screen.getByLabelText("Claude Opus 4.7");
    });
    // Plain-text span, not a combobox/button — no dropdown affordance.
    expect(label.tagName).toBe("SPAN");
    expect(
      screen.queryByRole("combobox", { name: "Claude Opus 4.7" }),
    ).toBeNull();
  });
});
