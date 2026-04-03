import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@vm0/core";
import type {
  LogDetail,
  AgentEventsResponse,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const BASE_LOG_ID = "a0000000-0000-4000-a000-000000000010";

function mockDetailAPI(overrides: Partial<LogDetail> = {}) {
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

  const eventsResponse: AgentEventsResponse = {
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

function mockDetailAPIWithEvents(
  overrides: Partial<LogDetail>,
  eventsResponse: AgentEventsResponse,
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

  return { logDetail };
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

  it("should render trigger source with schedule link (ACT-D-018)", async () => {
    mockDetailAPI({
      triggerSource: "schedule",
      scheduleId: "sched-123",
      displayName: "Scheduled Agent",
    });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Scheduled Agent" }),
      ).toBeInTheDocument();
    });

    const scheduleLink = screen.getByRole("link", { name: "Schedule" });
    expect(scheduleLink).toBeInTheDocument();
    expect(scheduleLink.getAttribute("href")).toBe("/schedules/sched-123");
  });

  it("should render selected model with provider tooltip (ACT-D-019)", async () => {
    mockDetailAPI({
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4.5",
    });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
      featureSwitches: { [FeatureSwitchKey.ModelDetail]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("claude-sonnet-4.5")).toBeInTheDocument();
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

  it("should render step search results count (ACT-D-023)", async () => {
    const eventsResponse: AgentEventsResponse = {
      events: [
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Paris is the capital." }],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "London is in England." }],
            },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
        {
          sequenceNumber: 2,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Berlin is in Germany." }],
            },
          },
          createdAt: "2026-03-10T14:56:04Z",
        },
      ],
      hasMore: false,
      framework: "claude-code",
    };

    mockDetailAPIWithEvents({}, eventsResponse);

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("3 total")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "Paris");

    await waitFor(() => {
      expect(screen.getByText(/1\/3 matched/)).toBeInTheDocument();
    });
  });

  it("should render filtered message list (ACT-D-024)", async () => {
    const eventsResponse: AgentEventsResponse = {
      events: [
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Paris is the capital." }],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "London is in England." }],
            },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ],
      hasMore: false,
      framework: "claude-code",
    };

    mockDetailAPIWithEvents({}, eventsResponse);

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "Paris");

    await waitFor(() => {
      expect(screen.getByText(/1\/2 matched/)).toBeInTheDocument();
    });

    // The matching message should be visible
    expect(screen.getByText(/Paris is the capital/)).toBeInTheDocument();
    // The non-matching message should not be visible
    expect(screen.queryByText(/London is in England/)).toBeNull();
  });

  it("should render prompt content as collapsible (ACT-D-025)", async () => {
    mockDetailAPI({
      prompt: "Build a web app with authentication and database",
    });

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    // The <details> element content paragraph is not visible when collapsed
    const promptParagraph = () => {
      return screen
        .getAllByText("Build a web app with authentication and database")
        .find((el) => {
          return el.tagName === "P";
        });
    };
    expect(promptParagraph()).not.toBeVisible();

    // Expand the prompt
    await user.click(screen.getByText("Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });
  });

  it("should render system prompt content as collapsible (ACT-D-026)", async () => {
    mockDetailAPI({ appendSystemPrompt: "You are a coding assistant" });

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
      featureSwitches: { [FeatureSwitchKey.ShowSystemPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("System Prompt")).toBeInTheDocument();
    });

    // Initially the full content paragraph is not visible
    const promptParagraph = () => {
      return screen.getAllByText("You are a coding assistant").find((el) => {
        return el.tagName === "P";
      });
    };
    expect(promptParagraph()).not.toBeVisible();

    // Expand the system prompt
    await user.click(screen.getByText("System Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });
  });

  it("should render messages list with search highlighting (ACT-D-027)", async () => {
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

    mockDetailAPIWithEvents({}, eventsResponse);

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

    // Verify the search input has the typed value
    expect(searchInput).toHaveValue("Eiffel");

    // Verify filtered results count
    await waitFor(() => {
      expect(screen.getByText(/1\/2 matched/)).toBeInTheDocument();
    });
  });
});
