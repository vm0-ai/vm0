import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const BASE_LOG_ID = "a0000000-0000-4000-a000-000000000010";

function mockDetailAPI(
  overrides: Partial<LogDetail> = {},
  eventsOverride?: AgentEventsResponse,
) {
  const logDetail: LogDetail = {
    id: BASE_LOG_ID,
    sessionId: "session_display",
    agentId: "test-agent",
    displayName: "Display Test Agent",
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
    ...overrides,
  };

  const eventsResponse: AgentEventsResponse = eventsOverride ?? {
    events: [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Hello there!" }] },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ],
    hasMore: false,
    framework: "claude-code",
  };

  server.use(
    http.get("*/api/zero/logs/:id", () => {
      return HttpResponse.json(logDetail);
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(eventsResponse);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );

  return { logDetail, eventsResponse };
}

describe("zeroActivityDetailPageDisplay", () => {
  it("should render agent display name in header (ACT-D-016)", async () => {
    mockDetailAPI({ displayName: "My Custom Agent" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "My Custom Agent" }),
      ).toBeInTheDocument();
    });
  });

  it("should render completed status badge as Done (ACT-D-017)", async () => {
    mockDetailAPI({ status: "completed" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("should render failed status badge as Failed (ACT-D-017)", async () => {
    mockDetailAPI({ status: "failed", error: "Something went wrong" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  it("should render formatted run duration (ACT-D-020)", async () => {
    mockDetailAPI({
      startedAt: "2026-03-10T14:56:01Z",
      completedAt: "2026-03-10T14:56:10Z",
    });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("9.0s")).toBeInTheDocument();
    });
  });

  it("should render formatted start time (ACT-D-021)", async () => {
    mockDetailAPI({ createdAt: "2026-03-10T14:56:00Z" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    // formatLogTime outputs "MM/DD HH:MM AM/PM" format
    await waitFor(() => {
      expect(
        screen.getByText(/\d{2}\/\d{2}\s+\d{2}:\d{2}\s+(AM|PM)/),
      ).toBeInTheDocument();
    });
  });

  it("should render error message with guidance (ACT-D-022)", async () => {
    mockDetailAPI({
      status: "failed",
      error: "No model provider configured",
    });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("No model provider configured"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("Configure a model provider to start running agents."),
    ).toBeInTheDocument();

    expect(
      screen.getByText("$ zero org model-provider setup"),
    ).toBeInTheDocument();
  });

  it("should filter messages and hide non-matching steps when searching (ACT-D-027)", async () => {
    const eventsResponse: AgentEventsResponse = {
      events: [
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                { type: "text", text: "The Eiffel Tower is in Paris." },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Big Ben is in London." }],
            },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ],
      hasMore: false,
      framework: "claude-code",
    };

    mockDetailAPI({}, eventsResponse);

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "Eiffel");

    // Verify filtered results count updates
    await waitFor(() => {
      expect(screen.getByText(/1\/2 matched/)).toBeInTheDocument();
    });

    // The matching message should remain visible
    expect(
      screen.getByText(/The Eiffel Tower is in Paris/),
    ).toBeInTheDocument();
    // The non-matching message should be filtered out
    expect(screen.queryByText(/Big Ben is in London/)).toBeNull();
  });
});
