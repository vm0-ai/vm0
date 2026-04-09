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

function mockActivityAPIs() {
  const listData = [
    {
      id: "a0000000-0000-4000-a000-000000000001",
      sessionId: "session_1",
      agentId: "test-agent",
      displayName: "Test Agent",
      orgSlug: "test",
      framework: "claude-code",
      status: "completed",
      triggerSource: "web",
      triggerAgentName: null,
      scheduleId: null,
      createdAt: "2026-03-10T14:56:00Z",
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
    },
  ];

  const logDetail: LogDetail = {
    id: "a0000000-0000-4000-a000-000000000001",
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
    prompt: "Hello, what can you do?",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
  };

  const eventsResponse: AgentEventsResponse = {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: { message: { content: [{ type: "text", text: "Hi!" }] } },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  server.use(
    http.get("*/api/zero/logs", () => {
      return HttpResponse.json({
        data: listData,
        pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
        filters: { statuses: [], sources: [], agents: [] },
      });
    }),
    http.get("*/api/zero/composes/list", () => {
      return HttpResponse.json({ composes: [] });
    }),
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === "a0000000-0000-4000-a000-000000000001") {
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
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("activity navigation", () => {
  it("should load detail page when clicking an activity row from the list", async () => {
    const user = userEvent.setup();
    mockActivityAPIs();

    detachedSetupPage({
      context,
      path: "/activities",
    });

    // Wait for the list to render with the activity row
    await waitFor(() => {
      expect(screen.getByText("Test Agent")).toBeInTheDocument();
    });

    // Click the activity row to navigate to detail
    await user.click(screen.getByText("Test Agent"));

    // The detail page should render with the agent name as heading
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Test Agent" }),
      ).toBeInTheDocument();
    });

    // Verify the detail content is visible (duration)
    expect(screen.getByText("9.0s")).toBeInTheDocument();
  });
});
