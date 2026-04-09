import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import type {
  LogDetail,
  AgentEvent,
} from "../../../signals/zero-page/log-types.ts";

const context = testContext();

const BASE_LOG_ID = "a7000000-0000-4000-8000-000000000001";

function makeLogDetail(overrides: Partial<LogDetail> = {}): LogDetail {
  return {
    id: BASE_LOG_ID,
    sessionId: "session_ts",
    agentId: "test-agent",
    displayName: "Tool Summary Agent",
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

function mockDetailAPI(events: AgentEvent[]): void {
  const logDetail = makeLogDetail();
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

async function renderActivityPage(): Promise<void> {
  detachedSetupPage({ context, path: `/activities/${BASE_LOG_ID}` });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Tool Summary Agent" }),
    ).toBeInTheDocument();
  });
}

describe("toolSummary", () => {
  it("tool name renders (ACT-D-075)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-075",
                name: "Read",
                input: { file_path: "/tmp/test.txt" },
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ]);
    await renderActivityPage();
    await waitFor(() => {
      expect(screen.getByText("Read")).toBeInTheDocument();
    });
  });

  it("key parameter value renders (ACT-D-076)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-076",
                name: "Bash",
                input: { command: "echo hello-076" },
              },
            ],
          },
        },
        createdAt: "2026-03-10T14:56:02Z",
      },
    ]);
    await renderActivityPage();
    await waitFor(() => {
      // Key param appears in the summary header — verify at least one instance is present
      const matches = screen.getAllByText("echo hello-076");
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it("result content with line preview renders (ACT-D-077)", async () => {
    const longContent = "line1\nline2\nline3\nline4\nline5";
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-077",
                name: "Bash",
                input: { command: "cat file" },
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
                tool_use_id: "tu-077",
                content: longContent,
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 100, bytes: longContent.length },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);
    await renderActivityPage();

    // Open outer details to see contents
    const detailsEl = await waitFor(() => {
      const el = screen.getByTestId("tool-summary");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });
    detailsEl.open = true;

    await waitFor(() => {
      expect(screen.getByText(/\+2 lines/)).toBeInTheDocument();
    });
    // First 3 lines visible in the preview
    expect(screen.getByText(/line1/)).toBeInTheDocument();
    // Inner expandable details starts closed (not open)
    const innerDetails = screen.getByTestId(
      "tool-result-expand",
    ) as HTMLDetailsElement;
    expect(innerDetails.open).toBeFalsy();
  });

  it("tool input details render (ACT-D-078)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-078",
                name: "Bash",
                input: { command: "ls -la /tmp/input-details-078" },
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
                tool_use_id: "tu-078",
                content: "result",
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 50, bytes: 6 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);
    await renderActivityPage();

    const detailsEl = await waitFor(() => {
      const el = screen.getByTestId("tool-summary");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });
    detailsEl.open = true;

    await waitFor(() => {
      // Command appears in the tool input details pre block
      const matches = screen.getAllByText("ls -la /tmp/input-details-078");
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it("formatted duration renders (ACT-D-079)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-079",
                name: "Bash",
                input: { command: "sleep 1" },
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
                tool_use_id: "tu-079",
                content: "done",
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 1500, bytes: 4 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);
    await renderActivityPage();

    const detailsEl = await waitFor(() => {
      const el = screen.getByTestId("tool-summary");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });
    detailsEl.open = true;

    await waitFor(() => {
      expect(screen.getByText("Duration: 1.5s")).toBeInTheDocument();
    });
  });

  it("error message renders for failed tools (ACT-D-080)", async () => {
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-080",
                name: "Bash",
                input: { command: "bad-command" },
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
                tool_use_id: "tu-080",
                content: "Command not found: bad-command",
                is_error: true,
              },
            ],
          },
          tool_use_result: { durationMs: 10, bytes: 30 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);
    await renderActivityPage();

    await waitFor(() => {
      // Error text appears in both the header span and the result pre; verify at least one exists
      const elements = screen.getAllByText("Command not found: bad-command");
      expect(elements.length).toBeGreaterThan(0);
    });
  });

  describe("dynamic status dot renders based on state (ACT-D-081)", () => {
    it("renders success indicator when tool has successful result", async () => {
      mockDetailAPI([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-081-s",
                  name: "Bash",
                  input: { command: "echo ok" },
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
                  tool_use_id: "tu-081-s",
                  content: "ok",
                  is_error: false,
                },
              ],
            },
            tool_use_result: { durationMs: 50, bytes: 2 },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ]);
      await renderActivityPage();

      // Tool name is visible and there is no error styling
      await waitFor(() => {
        expect(screen.getByText("Bash")).toBeInTheDocument();
      });
      // No error text present — tool completed successfully
      expect(
        screen.queryByText(/error/i, { exact: false }),
      ).not.toBeInTheDocument();
    });

    it("renders error indicator when tool has error result", async () => {
      mockDetailAPI([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-081-e",
                  name: "Bash",
                  input: { command: "fail" },
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
                  tool_use_id: "tu-081-e",
                  content: "error occurred",
                  is_error: true,
                },
              ],
            },
            tool_use_result: { durationMs: 10, bytes: 14 },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ]);
      await renderActivityPage();

      // Error content is displayed when tool fails
      await waitFor(() => {
        const matches = screen.getAllByText("error occurred");
        expect(matches.length).toBeGreaterThan(0);
      });
    });

    it("renders pending indicator when tool has no result yet", async () => {
      mockDetailAPI([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-081-p",
                  name: "Bash",
                  input: { command: "long-running" },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]);
      await renderActivityPage();

      // Tool name is visible but no result content appears yet
      await waitFor(() => {
        expect(screen.getByText("Bash")).toBeInTheDocument();
      });
      // No duration shown when there's no result
      expect(screen.queryByText(/Duration:/)).not.toBeInTheDocument();
    });
  });

  it("collapsible tool details toggle (ACT-D-082)", async () => {
    const user = userEvent.setup();
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-082",
                name: "Bash",
                input: { command: "echo toggle" },
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
                tool_use_id: "tu-082",
                content: "toggle output",
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 50, bytes: 13 },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);
    await renderActivityPage();

    const detailsEl = await waitFor(() => {
      const el = screen.getByTestId("tool-summary");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });

    // Initially closed (no search term active)
    expect(detailsEl.open).toBeFalsy();

    // Click the summary to open
    const summary = detailsEl.querySelector("summary");
    expect(summary).not.toBeNull();
    await user.click(summary!);

    expect(detailsEl.open).toBeTruthy();

    // Click again to close
    await user.click(summary!);
    expect(detailsEl.open).toBeFalsy();
  });

  it("expandable result preview shows more lines (ACT-D-083)", async () => {
    const user = userEvent.setup();
    const content = "alpha\nbeta\ngamma\ndelta\nepsilon";
    mockDetailAPI([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tu-083",
                name: "Bash",
                input: { command: "cat long-file" },
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
                tool_use_id: "tu-083",
                content: content,
                is_error: false,
              },
            ],
          },
          tool_use_result: { durationMs: 100, bytes: content.length },
        },
        createdAt: "2026-03-10T14:56:03Z",
      },
    ]);
    await renderActivityPage();

    // Open outer details
    const outerDetails = await waitFor(() => {
      const el = screen.getByTestId("tool-summary");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });
    outerDetails.open = true;

    // Wait for "+2 lines" summary to appear
    const expandSummary = await waitFor(() => {
      return screen.getByText(/\+2 lines/);
    });

    // Inner expandable details starts closed
    const innerDetails = screen.getByTestId(
      "tool-result-expand",
    ) as HTMLDetailsElement;
    expect(innerDetails.open).toBeFalsy();

    // Click "+2 lines" to expand
    await user.click(expandSummary);

    // Inner details is now open
    await waitFor(() => {
      expect(innerDetails.open).toBeTruthy();
    });
  });
});
