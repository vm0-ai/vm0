import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEventsResponse,
  AgentEvent,
} from "../../../signals/zero-page/log-types.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { logsByIdContract, zeroRunAgentEventsContract } from "@vm0/core";

const context = testContext();

const BASE_LOG_ID = "ec000000-0000-4000-8000-000000000001";

function makeBaseLogDetail(overrides: Partial<LogDetail> = {}): LogDetail {
  return {
    id: BASE_LOG_ID,
    sessionId: "session_event_card",
    agentId: "test-agent",
    displayName: "Event Card Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "Test prompt",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
    ...overrides,
  };
}

function mockDetailAPI(events: AgentEvent[]) {
  const logDetail = makeBaseLogDetail();
  const eventsResponse: AgentEventsResponse = {
    events,
    hasMore: false,
    framework: "claude-code",
  };

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
}

async function renderActivityPage() {
  detachedSetupPage({
    context,
    path: `/activities/${BASE_LOG_ID}`,
  });

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Event Card Agent" }),
    ).toBeInTheDocument();
  });
}

describe("eventCard", () => {
  it("should render tool names with count (ACT-D-056)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: { subtype: "init", tools: ["Bash", "Read", "Grep"] },
        createdAt: "2026-03-10T14:56:01Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("3 tools")).toBeInTheDocument();
    });
  });

  it("should render agent names with count (ACT-D-057)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: { subtype: "init", agents: ["coder", "reviewer"] },
        createdAt: "2026-03-10T14:56:01Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("2 agents")).toBeInTheDocument();
    });
  });

  it("should render slash commands with count (ACT-D-058)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "init",
          slash_commands: ["commit", "review-pr"],
        },
        createdAt: "2026-03-10T14:56:01Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("2 commands")).toBeInTheDocument();
    });
  });

  it("should render duration text (ACT-D-059)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: { duration_ms: 125_000, result: "Done" },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("2m 5s")).toBeInTheDocument();
    });
  });

  it("should render turn count (ACT-D-060)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: { num_turns: 7, result: "Done" },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("7 turns")).toBeInTheDocument();
    });
  });

  it("should render model usage details (ACT-D-061)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: {
          modelUsage: {
            "claude-sonnet-4": {
              inputTokens: 1500,
              outputTokens: 800,
              costUSD: 0.05,
            },
          },
          result: "Done",
        },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("1 models")).toBeInTheDocument();
    });
  });

  it("should render result markdown text (ACT-D-062)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: { result: "Task **completed** successfully" },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ]);

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("completed")).toBeInTheDocument();
    });
  });

  it("should expand category popover with tool details (ACT-D-063)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: { subtype: "init", tools: ["Bash", "Read"] },
        createdAt: "2026-03-10T14:56:01Z",
      },
    ]);

    const user = userEvent.setup();

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("2 tools")).toBeInTheDocument();
    });

    await user.click(screen.getByText("2 tools"));

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
      expect(screen.getByText("Read")).toBeInTheDocument();
    });
  });

  it("should expand model usage popover with details (ACT-D-064)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: {
          modelUsage: {
            "claude-sonnet-4": {
              inputTokens: 1500,
              outputTokens: 800,
            },
          },
          result: "Done",
        },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ]);

    const user = userEvent.setup();

    await renderActivityPage();

    await waitFor(() => {
      expect(screen.getByText("1 models")).toBeInTheDocument();
    });

    await user.click(screen.getByText("1 models"));

    await waitFor(() => {
      expect(screen.getByText("claude-sonnet-4")).toBeInTheDocument();
      expect(screen.getByText("in: 1,500")).toBeInTheDocument();
      expect(screen.getByText("out: 800")).toBeInTheDocument();
    });
  });
});
