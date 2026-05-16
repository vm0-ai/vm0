import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { zeroRunAgentEventsContract } from "@vm0/api-contracts/contracts/zero-runs";
import type {
  LogDetail,
  AgentEventsResponse,
  AgentEvent,
} from "../../../signals/zero-page/log-types.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
  eventsOrResponse: AgentEvent[] | AgentEventsResponse = [],
) {
  const logDetail = makeBaseLogDetail(overrides);
  const eventsResponse: AgentEventsResponse = Array.isArray(eventsOrResponse)
    ? makeEventsResponse(eventsOrResponse)
    : eventsOrResponse;

  server.use(
    mockApi(logsByIdContract.getById, ({ params, respond }) => {
      if (params.id === logDetail.id) {
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

  return { logDetail, eventsResponse };
}

describe("zeroActivityDetailPageDisplay", () => {
  it("should render agent display name in header (ACT-D-016)", async () => {
    mockDetailAPI({ displayName: "My Custom Agent" });

    detachedSetupPage({
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

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("should render failed status badge as Failed (ACT-D-017)", async () => {
    mockDetailAPI({ status: "failed", error: "Something went wrong" });

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });
  });

  it("should render trigger source with schedule link (ACT-D-018)", async () => {
    mockDetailAPI({ triggerSource: "schedule", scheduleId: "sched-123" });

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    const scheduleLink = screen.getByText("Schedule");
    expect(scheduleLink).toBeInTheDocument();
    expect(scheduleLink.getAttribute("href")).toContain("/schedules/sched-123");
  });

  it("should render selected model when present (ACT-D-019)", async () => {
    mockDetailAPI({
      modelProvider: "anthropic-api-key",
      selectedModel: "claude-sonnet-4.5",
    });

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
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

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("9.0s")).toBeInTheDocument();
    });
  });

  it("should render formatted start time (ACT-D-021)", async () => {
    mockDetailAPI({ createdAt: "2026-03-10T14:56:00Z" });

    detachedSetupPage({
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

    detachedSetupPage({
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
      screen.getByText("$ zero model-provider set --help"),
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

    detachedSetupPage({
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

    detachedSetupPage({
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

  it("should keep final Codex text before an empty turn result", async () => {
    const finalText = "Codex final answer stays visible.";
    const eventsResponse: AgentEventsResponse = {
      events: [
        {
          sequenceNumber: 1,
          eventType: "item.completed",
          eventData: {
            type: "item.completed",
            item: {
              id: "item-final-message",
              type: "agent_message",
              text: finalText,
            },
          },
          createdAt: "2026-03-10T14:56:08Z",
        },
        {
          sequenceNumber: 2,
          eventType: "turn.completed",
          eventData: {
            type: "turn.completed",
            usage: {
              input_tokens: 10,
              output_tokens: 20,
            },
          },
          createdAt: "2026-03-10T14:56:10Z",
        },
      ],
      hasMore: false,
      framework: "codex",
    };

    mockDetailAPI(
      {
        framework: "codex",
        modelProvider: "openai-api-key",
        selectedModel: "gpt-5.5",
      },
      eventsResponse,
    );

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });
    expect(screen.getByText(finalText)).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
  });

  it("should hide text-only Claude messages before a non-empty result", async () => {
    const events: AgentEvent[] = [
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Draft final answer" }],
          },
        },
        createdAt: "2026-03-10T14:56:08Z",
      },
      {
        sequenceNumber: 2,
        eventType: "result",
        eventData: {
          result: "Claude result answer",
          is_error: false,
        },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ];

    mockDetailAPI({}, events);

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Display Test Agent" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("1 total")).toBeInTheDocument();
    });
    expect(screen.queryByText("Draft final answer")).toBeNull();
    expect(screen.getByText("Claude result answer")).toBeInTheDocument();
  });

  it("should render prompt content in a collapsible block (ACT-D-025)", async () => {
    mockDetailAPI({ prompt: "Build a web app" });

    detachedSetupPage({
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

    click(screen.getByText("Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });
  });

  it("should render system prompt content in a collapsible block when feature enabled (ACT-D-026)", async () => {
    mockDetailAPI({ appendSystemPrompt: "You are a coding assistant" });

    detachedSetupPage({
      context,
      path: `/activities/${BASE_LOG_ID}`,
      featureSwitches: { [FeatureSwitchKey.ZeroDebug]: true },
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
    click(screen.getByText("System Prompt"));

    await waitFor(() => {
      expect(promptParagraph()).toBeVisible();
    });
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

    detachedSetupPage({
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
