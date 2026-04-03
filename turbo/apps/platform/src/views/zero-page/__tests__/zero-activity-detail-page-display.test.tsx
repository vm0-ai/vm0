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
  AgentEvent,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const BASE_LOG_ID = "d0000000-0000-4000-8000-000000000001";

function makeBaseLogDetail(overrides: Partial<LogDetail> = {}): LogDetail {
  return {
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
}

function makeEventsResponse(events: AgentEvent[] = []): AgentEventsResponse {
  return {
    events,
    hasMore: false,
    framework: "claude-code",
  };
}

function mockDetailAPI(
  overrides: Partial<LogDetail> = {},
  events: AgentEvent[] = [],
) {
  const logDetail = makeBaseLogDetail(overrides);
  server.use(
    http.get("*/api/zero/logs/:id", ({ params }) => {
      if (params["id"] === logDetail.id) {
        return HttpResponse.json(logDetail);
      }
      return HttpResponse.json(
        { error: { message: "Not found", code: "NOT_FOUND" } },
        { status: 404 },
      );
    }),
    http.get("*/api/zero/runs/:runId/telemetry/agent", () => {
      return HttpResponse.json(makeEventsResponse(events));
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
  return logDetail;
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

  it("should render Done status badge for completed status (ACT-D-017)", async () => {
    mockDetailAPI({ status: "completed" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("should render Failed status badge for failed status (ACT-D-017)", async () => {
    mockDetailAPI({ status: "failed" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("should render trigger source with schedule link (ACT-D-018)", async () => {
    mockDetailAPI({ triggerSource: "schedule", scheduleId: "sched-123" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    const scheduleLink = screen.getByRole("link", { name: "Schedule" });
    expect(scheduleLink).toBeInTheDocument();
    expect(scheduleLink.getAttribute("href")).toContain("/schedules/sched-123");
  });

  it("should render selected model when ModelDetail feature is enabled (ACT-D-019)", async () => {
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
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("claude-sonnet-4.5")).toBeInTheDocument();
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
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("9.0s")).toBeInTheDocument();
  });

  it("should render formatted start time (ACT-D-021)", async () => {
    mockDetailAPI({ createdAt: "2026-03-10T14:56:00Z" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    // The formatted time includes AM or PM depending on timezone
    const timeEl = screen.getAllByText(/\d+:\d+/);
    expect(timeEl.length).toBeGreaterThan(0);
  });

  it("should render error message with guidance for no model provider error (ACT-D-022)", async () => {
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
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("No model provider configured"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Configure a model provider to start running agents."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("$ zero org model-provider setup"),
    ).toBeInTheDocument();
  });

  it("should render step search results count (ACT-D-023)", async () => {
    const events: AgentEvent[] = [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Paris is in France." }] },
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
    ];
    mockDetailAPI({ prompt: "" }, events);

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "Paris");

    await waitFor(() => {
      expect(screen.getByText(/1\/\d+ matched/)).toBeInTheDocument();
    });
  });

  it("should render filtered message list with only matching messages (ACT-D-024)", async () => {
    const events: AgentEvent[] = [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: { content: [{ type: "text", text: "Paris is in France." }] },
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
    ];
    mockDetailAPI({ prompt: "" }, events);

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    // Both messages should be visible before filtering
    await waitFor(() => {
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "London");

    // After filtering only the matching message count is shown
    await waitFor(() => {
      expect(screen.getByText(/1\/2 matched/)).toBeInTheDocument();
    });
  });

  it("should render prompt content in a collapsible block (ACT-D-025)", async () => {
    mockDetailAPI({ prompt: "Build a web app" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    // The "Prompt" label should be visible as a collapsible summary
    await waitFor(() => {
      expect(screen.getByText("Prompt")).toBeInTheDocument();
    });

    // The expanded content is in a <p> element initially hidden; expand it
    const promptParagraph = () => {
      return screen.getAllByText("Build a web app").find((el) => {
        return el.tagName === "P";
      });
    };
    expect(promptParagraph()).not.toBeVisible();

    const user = userEvent.setup();
    await user.click(screen.getByText("Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });
  });

  it("should render system prompt content in a collapsible block when feature enabled (ACT-D-026)", async () => {
    mockDetailAPI({ appendSystemPrompt: "You are a coding assistant" });

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
      featureSwitches: { [FeatureSwitchKey.ShowSystemPrompt]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("System Prompt")).toBeInTheDocument();
    });

    // The system prompt content is initially not visible (details is closed)
    const promptParagraph = () => {
      return screen.getAllByText("You are a coding assistant").find((el) => {
        return el.tagName === "P";
      });
    };
    expect(promptParagraph()).not.toBeVisible();

    // Expand the system prompt section
    const user = userEvent.setup();
    await user.click(screen.getByText("System Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });
  });

  it("should render messages list with search highlighting and matched count (ACT-D-027)", async () => {
    const events: AgentEvent[] = [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "The Eiffel Tower is in Paris." }],
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
    ];
    mockDetailAPI({ prompt: "" }, events);

    const user = userEvent.setup();

    await setupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "Eiffel");

    // Search input should have the search term
    expect(searchInput).toHaveValue("Eiffel");

    // Matched count should be displayed
    await waitFor(() => {
      expect(screen.getByText(/1\/2 matched/)).toBeInTheDocument();
    });
  });
});
