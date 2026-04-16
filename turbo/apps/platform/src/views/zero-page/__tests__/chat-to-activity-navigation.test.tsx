import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockChatWithActivityLink() {
  server.use(
    http.get(
      "*/api/zero/chat-threads/thread-with-activity/messages",
      ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("sinceId")) {
          return HttpResponse.json({ messages: [], hasMore: false });
        }
        return HttpResponse.json({
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
          hasMore: false,
        });
      },
    ),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-with-activity",
        title: null,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:05Z",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
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

  server.use(
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "c0000000-0000-4000-a000-000000000001",
            name: "test-agent",
            displayName: "Test Agent",
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "a0000000-0000-4000-a000-000000000011") {
        return HttpResponse.json(logDetail);
      }
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(eventsResponse);
    }),
  );
}

describe("chat to activity navigation", () => {
  it("should initialize activity detail page when clicking activity link from chat", async () => {
    const user = userEvent.setup();
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
    await user.click(activityLink);

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
