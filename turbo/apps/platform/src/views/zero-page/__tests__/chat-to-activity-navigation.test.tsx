import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function mockChatWithActivityLink() {
  server.use(
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-with-activity",
        title: null,
        agentComposeId: "mock-compose-id",
        chatMessages: [
          {
            role: "user",
            content: "Run the task",
            createdAt: "2026-03-10T00:00:00Z",
          },
          {
            role: "assistant",
            content: "Task completed successfully.",
            runId: "run_activity_1",
            createdAt: "2026-03-10T00:00:05Z",
          },
        ],
        latestSessionId: null,
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
    id: "run_activity_1",
    sessionId: "session_1",
    agentName: "test-agent",
    displayName: "Test Agent",
    framework: "claude-code",
    modelProvider: null,
    triggerSource: "web",
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
        composes: [{ name: "test-agent", displayName: "Test Agent" }],
      });
    }),
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "run_activity_1") {
        return HttpResponse.json(logDetail);
      }
      return new HttpResponse(null, { status: 404 });
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(eventsResponse);
    }),
  );
}

describe("chat to activity navigation", () => {
  it("should initialize activity detail page when clicking activity link from chat", async () => {
    mockChatWithActivityLink();
    mockActivityDetailAPIs();

    await setupPage({
      context,
      path: "/chat/thread-with-activity",
    });

    // Wait for chat messages to render
    await waitFor(
      () => {
        expect(
          screen.getByText("Task completed successfully."),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Find and click the "View run logs" link that navigates to /activity/run_activity_1
    const activityLink = screen.getByLabelText("View run logs");
    expect(activityLink).toBeInTheDocument();
    fireEvent.click(activityLink);

    // The activity detail page should fully initialize and show the agent name heading
    await waitFor(
      () => {
        expect(
          screen.getByRole("heading", { name: "Test Agent" }),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Verify the detail content loaded (duration: 4.0s)
    expect(screen.getByText("4.0s")).toBeInTheDocument();
  }, 15_000);
});
