import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEvent,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const BASE_LOG_ID = "5c000000-0000-4000-8000-000000000001";

function makeLogDetail(overrides: Partial<LogDetail> = {}): LogDetail {
  return {
    id: BASE_LOG_ID,
    sessionId: "session_sc",
    agentId: "test-agent",
    displayName: "Status Component Agent",
    framework: "claude-code",
    modelProvider: null,
    selectedModel: null,
    triggerSource: "web",
    triggerAgentName: null,
    scheduleId: null,
    status: "completed",
    prompt: "",
    appendSystemPrompt: null,
    error: null,
    createdAt: "2026-03-10T14:56:00Z",
    startedAt: "2026-03-10T14:56:01Z",
    completedAt: "2026-03-10T14:56:10Z",
    artifact: { name: null, version: null },
    ...overrides,
  };
}

function mockDetailAPI(
  overrides: Partial<LogDetail> = {},
  events: AgentEvent[] = [],
): void {
  const logDetail = makeLogDetail(overrides);
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
      return HttpResponse.json({
        events,
        hasMore: false,
        framework: "claude-code",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderActivityDetail(
  overrides: Partial<LogDetail> = {},
  events: AgentEvent[] = [],
): Promise<void> {
  mockDetailAPI(overrides, events);
  await setupPage({ context, path: `/activities/${BASE_LOG_ID}` });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Status Component Agent" }),
    ).toBeInTheDocument();
  });
}

// ============ STATUS BADGE TESTS ============

describe("statusBadge", () => {
  it("should render icon for completed status (ACT-D-084)", async () => {
    await renderActivityDetail({ status: "completed" });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });

    const badge = screen.getByTestId("status-badge");
    expect(badge.querySelector("svg")).toBeInTheDocument();
  });

  it("should render icon for failed status (ACT-D-084)", async () => {
    await renderActivityDetail({
      status: "failed",
      error: "Something went wrong",
    });

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    const badge = screen.getByTestId("status-badge");
    expect(badge.querySelector("svg")).toBeInTheDocument();
  });

  it("should render icon for cancelled status (ACT-D-084)", async () => {
    await renderActivityDetail({ status: "cancelled" });

    await waitFor(() => {
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
    });

    const badge = screen.getByTestId("status-badge");
    expect(badge.querySelector("svg")).toBeInTheDocument();
  });

  it("should render label text for completed status (ACT-D-085)", async () => {
    await renderActivityDetail({ status: "completed" });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
  });

  it("should render label text for cancelled status (ACT-D-085)", async () => {
    await renderActivityDetail({ status: "cancelled" });

    await waitFor(() => {
      expect(screen.getByText("Cancelled")).toBeInTheDocument();
    });
  });

  it("should render label text for timeout status (ACT-D-085)", async () => {
    await renderActivityDetail({ status: "timeout" });

    await waitFor(() => {
      expect(screen.getByText("Timeout")).toBeInTheDocument();
    });
  });

  it("should apply green color class for completed status (ACT-D-086)", async () => {
    await renderActivityDetail({ status: "completed" });

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });

    const badge = screen.getByTestId("status-badge");
    const icon = badge.querySelector("svg");
    expect(icon?.className).toContain("text-green-600");
  });

  it("should apply red color class for failed status (ACT-D-086)", async () => {
    await renderActivityDetail({ status: "failed", error: "err" });

    await waitFor(() => {
      expect(screen.getByText("Failed")).toBeInTheDocument();
    });

    const badge = screen.getByTestId("status-badge");
    const icon = badge.querySelector("svg");
    expect(icon?.className).toContain("text-red-600");
  });

  it("should apply orange color class for timeout status (ACT-D-086)", async () => {
    await renderActivityDetail({ status: "timeout" });

    await waitFor(() => {
      expect(screen.getByText("Timeout")).toBeInTheDocument();
    });

    const badge = screen.getByTestId("status-badge");
    const icon = badge.querySelector("svg");
    expect(icon?.className).toContain("text-orange-600");
  });
});

// ============ STATUS DOT TESTS ============

describe("statusDot", () => {
  it("should render neutral dot for system init events (ACT-D-087)", async () => {
    await renderActivityDetail({}, [
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: { subtype: "init", tools: [] },
        createdAt: "2026-03-10T14:56:01Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Initialize")).toBeInTheDocument();
    });

    // StatusDot renders a ● character in a span with aria-hidden="true"
    const allHiddenSpans = document.querySelectorAll(
      'span[aria-hidden="true"]',
    );
    const dotSpan = Array.from(allHiddenSpans).find((el) => {
      return el.textContent === "●";
    });
    expect(dotSpan).toBeTruthy();
  });

  it("should render primary dot for result events (ACT-D-087)", async () => {
    await renderActivityDetail({}, [
      {
        sequenceNumber: 0,
        eventType: "result",
        eventData: { result: "Done" },
        createdAt: "2026-03-10T14:56:10Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Summary")).toBeInTheDocument();
    });

    const primaryDot = document.querySelector(
      'span[aria-hidden="true"].text-orange-600',
    );
    expect(primaryDot).toBeInTheDocument();
    expect(primaryDot?.textContent).toBe("●");
  });

  it("should render success dot for tool with successful result (ACT-D-087)", async () => {
    await renderActivityDetail({}, [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-1",
                name: "Bash",
                input: { command: "echo hello" },
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
      {
        sequenceNumber: 1,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-1",
                content: "hello",
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 100, bytes: 5 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    const successDot = document.querySelector(
      'span[aria-hidden="true"].text-green-700',
    );
    expect(successDot).toBeInTheDocument();
    expect(successDot?.textContent).toBe("●");
  });

  it("should render error dot for tool with error result (ACT-D-087)", async () => {
    await renderActivityDetail({}, [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-err-1",
                name: "Bash",
                input: { command: "invalid-cmd" },
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
      {
        sequenceNumber: 1,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-err-1",
                content: "command not found",
                is_error: true,
              },
            ],
          },
          tool_use_result: { durationMs: 50, bytes: 18 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    const errorDot = document.querySelector(
      'span[aria-hidden="true"].text-red-700',
    );
    expect(errorDot).toBeInTheDocument();
    expect(errorDot?.textContent).toBe("●");
  });
});

// ============ HIGHLIGHT TEXT TESTS ============

describe("highlightText", () => {
  it("should render mark spans with highlight styling for matches (ACT-D-088)", async () => {
    await renderActivityDetail({}, [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-hl-1",
                name: "Bash",
                input: { command: "ls /tmp/searchable-term" },
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
      {
        sequenceNumber: 1,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-hl-1",
                content: "searchable-term",
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 100, bytes: 15 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "searchable");

    await waitFor(() => {
      const marks = document.querySelectorAll("mark");
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) {
        expect(mark.className).toMatch(/bg-orange-[12]00/);
      }
    });
  });

  it("should render current match with distinct styling (ACT-D-088)", async () => {
    await renderActivityDetail({}, [
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-hl-2",
                name: "Bash",
                input: {
                  command: "echo unique-keyword && echo unique-keyword",
                },
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
      {
        sequenceNumber: 1,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tu-hl-2",
                content: "unique-keyword\nunique-keyword",
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 100, bytes: 30 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const searchInput = screen.getByPlaceholderText("Search steps");
    await user.type(searchInput, "unique-keyword");

    await waitFor(() => {
      const marks = document.querySelectorAll("mark");
      expect(marks.length).toBeGreaterThan(0);
      // The current match uses bg-orange-200, other matches use bg-orange-100
      const currentMarks = document.querySelectorAll("mark.bg-orange-200");
      const otherMarks = document.querySelectorAll("mark.bg-orange-100");
      expect(currentMarks.length + otherMarks.length).toBe(marks.length);
    });
  });
});
