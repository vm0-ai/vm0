import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadMessagesContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";
import { logsByIdContract } from "@vm0/core/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/core/contracts/zero-runs";
import { setMockComposesList } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockChatWithActivityLink() {
  server.use(
    mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
      if (query.sinceId) {
        return respond(200, { messages: [] });
      }
      return respond(200, {
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "Run the task",
            createdAt: "2026-03-10T00:00:00Z",
          },
          {
            id: "msg-2",
            role: "assistant",
            content: "Task completed successfully.",
            runId: "a0000000-0000-4000-a000-000000000011",
            createdAt: "2026-03-10T00:00:05Z",
          },
        ],
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "thread-with-activity",
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:05Z",
      });
    }),
  );
}

function mockActivityDetailAPIs() {
  const logDetail: LogDetail = {
    id: "a0000000-0000-4000-a000-000000000011",
    sessionId: "session_1",
    agentId: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Run the task",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T00:00:00Z",
    startedAt: "2026-03-10T00:00:01Z",
    completedAt: "2026-03-10T00:00:05Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Task completed." }] },
        },
        createdAt: "2026-03-10T00:00:03Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  setMockComposesList([
    {
      id: "c0000000-0000-4000-a000-000000000001",
      name: "test-agent",
      displayName: "Test Agent",
      description: null,
      sound: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(logsByIdContract.getById, ({ params, respond }) => {
      if (params.id === "a0000000-0000-4000-a000-000000000011") {
        return respond(200, logDetail);
      }
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }),
    mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, eventsResponse);
    }),
  );
}

describe("chat to activity navigation", () => {
  it("should initialize activity detail page when clicking activity link from chat", async () => {
    mockChatWithActivityLink();
    mockActivityDetailAPIs();

    detachedSetupPage({
      context,
      path: "/chats/thread-with-activity",
    });

    // Wait for chat messages to render
    await waitFor(() => {
      expect(
        screen.getByText("Task completed successfully."),
      ).toBeInTheDocument();
    });

    // Find and click the "View run logs" link that navigates to /activity/a0000000-0000-4000-a000-000000000011
    const activityLink = screen.getByLabelText("View run logs");
    expect(activityLink).toBeInTheDocument();
    click(activityLink);

    // The activity detail page should fully initialize and show the agent name heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Verify the detail content loaded (duration: 4.0s)
    expect(screen.getByText("4.0s")).toBeInTheDocument();
  });
});
