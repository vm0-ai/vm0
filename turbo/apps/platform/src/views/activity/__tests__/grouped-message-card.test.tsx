import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  loadInspectLogFile$,
  setInspectStepSearch$,
  type InspectLogData,
} from "../../../signals/activity-page/inspect-log-signals.ts";
import type { InspectLogMeta } from "../../../signals/activity-page/inspect-log-parser.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";

const context = testContext();

function makeInspectData(events: AgentEvent[]): InspectLogData {
  return {
    meta: {
      id: "a8000000-0000-4000-8000-000000000001",
      displayName: "GroupedCard Test Agent",
      status: "completed",
      triggerSource: "web",
      triggerAgentName: null,
      modelProvider: null,
      selectedModel: null,
      framework: "claude-code",
      error: null,
      scheduleId: null,
      prompt: "",
      appendSystemPrompt: null,
      createdAt: "2026-03-10T14:00:00Z",
      startedAt: "2026-03-10T14:00:01Z",
      completedAt: "2026-03-10T14:00:10Z",
    } satisfies InspectLogMeta,
    events,
    context: null,
    networkLogs: null,
  };
}

async function loadInspectData(data: InspectLogData): Promise<void> {
  const json = JSON.stringify({ meta: data.meta, events: data.events });
  const file = new File([json], "test.json", { type: "application/json" });
  await context.store.set(loadInspectLogFile$, file, context.signal);
}

function renderInspectPage(): void {
  detachedSetupPage({ context, path: "/activities/inspect" });
}

describe("groupedMessageCard", () => {
  // ACT-D-065
  it("formats and displays message timestamp", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Timestamp test message" }],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("Timestamp test message")).toBeInTheDocument();
    });

    // formatEventTime("2026-03-10T14:56:02Z") → "Mar 10, HH:MM:SS" (past date)
    await waitFor(() => {
      expect(screen.getAllByText(/Mar 10/).length).toBeGreaterThan(0);
    });
  });

  // ACT-D-066
  it("renders text sections for assistant messages", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "First text section" }],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            message: {
              content: [{ type: "text", text: "Second text section" }],
            },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("First text section")).toBeInTheDocument();
    });
    expect(screen.getByText("Second text section")).toBeInTheDocument();
  });

  // ACT-D-067
  it("renders todo items with their completion status icons", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-todo-067",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      { content: "Completed task", status: "completed" },
                      { content: "In progress task", status: "in_progress" },
                      { content: "Pending task", status: "pending" },
                    ],
                  },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("Todo")).toBeInTheDocument();
    });

    // Open the details by clicking the summary to see all items
    const todoHeading = screen.getByText("Todo");
    const details = todoHeading.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    const summary = details.querySelector("summary")!;
    click(summary);

    await waitFor(() => {
      expect(screen.getByText("Completed task")).toBeInTheDocument();
      // "In progress task" appears in summary + expanded list — use getAllByText
      expect(screen.getAllByText("In progress task").length).toBeGreaterThan(0);
      expect(screen.getByText("Pending task")).toBeInTheDocument();
    });
  });

  // ACT-D-068
  it("renders completedCount/totalCount progress indicator", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-todo-068",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      { content: "Done A", status: "completed" },
                      { content: "Done B", status: "completed" },
                      { content: "Current task", status: "in_progress" },
                    ],
                  },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("[2/3]")).toBeInTheDocument();
    });
  });

  // ACT-D-069
  it("renders current in-progress task content", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-todo-069",
                  name: "TodoWrite",
                  input: {
                    todos: [
                      { content: "First completed task", status: "completed" },
                      {
                        content: "Currently running task",
                        status: "in_progress",
                      },
                    ],
                  },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]),
    );

    await waitFor(() => {
      // Content appears in the summary line (inProgressTask.content)
      expect(
        screen.getAllByText("Currently running task").length,
      ).toBeGreaterThan(0);
    });
  });

  // ACT-D-070
  it("renders tool operations and their results", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-bash-070",
                  name: "Bash",
                  input: { command: "echo hello-070" },
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
                  tool_use_id: "tu-bash-070",
                  content: "hello-070",
                  is_error: false,
                },
              ],
            },
            tool_use_result: { durationMs: 50, bytes: 9 },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    // Open the tool summary details by clicking the summary to see result
    const toolSummary = screen.getByTestId(
      "tool-summary",
    ) as HTMLDetailsElement;
    const toolSummarySummary = toolSummary.querySelector("summary")!;
    click(toolSummarySummary);

    await waitFor(() => {
      expect(screen.getByText("hello-070")).toBeInTheDocument();
    });
  });

  // ACT-D-071
  it("highlights search matches in tool key parameters", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-bash-071",
                  name: "Bash",
                  input: { command: "unique-search-term-071" },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });

    // Set search term — this opens tool summary (hasSearchMatch=true) and highlights matches
    context.store.set(setInspectStepSearch$, "unique-search-term-071");

    await waitFor(() => {
      const marks = document.querySelectorAll("mark");
      expect(marks.length).toBeGreaterThan(0);
    });

    // Tool summary details auto-opens on search match
    const toolSummary = screen.getByTestId(
      "tool-summary",
    ) as HTMLDetailsElement;
    expect(toolSummary.open).toBeTruthy();
  });

  // ACT-D-072
  it("renders appropriate status dots based on message state", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-todo-072",
                  name: "TodoWrite",
                  input: {
                    todos: [{ content: "Task A", status: "in_progress" }],
                  },
                },
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
              content: [
                {
                  type: "tool_use",
                  id: "tu-bash-072",
                  name: "Bash",
                  input: { command: "echo success" },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
        {
          sequenceNumber: 2,
          eventType: "user",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tu-bash-072",
                  content: "success",
                  is_error: false,
                },
              ],
            },
            tool_use_result: { durationMs: 10, bytes: 7 },
          },
          createdAt: "2026-03-10T14:56:04Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("Todo")).toBeInTheDocument();
    });

    // Todo card has "todo" variant status dot
    expect(document.querySelector('[data-variant="todo"]')).toBeInTheDocument();

    // Bash with result has "success" variant
    expect(
      document.querySelector('[data-variant="success"]'),
    ).toBeInTheDocument();
  });

  // ACT-D-073
  it("expands and collapses todo section on click", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-todo-073",
                  name: "TodoWrite",
                  input: {
                    todos: [{ content: "Collapsible task", status: "pending" }],
                  },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText("Todo")).toBeInTheDocument();
    });

    // Find the todo details element — it wraps the "Todo" text in summary
    const todoHeading = screen.getByText("Todo");
    const details = todoHeading.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();

    // No search match → initially closed
    expect(details.open).toBeFalsy();

    const summary = details.querySelector("summary")!;

    // Click to expand
    click(summary);
    expect(details.open).toBeTruthy();

    // Click again to collapse
    click(summary);
    expect(details.open).toBeFalsy();
  });

  // ACT-D-074
  it("expands and collapses tool operation details on click", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "assistant",
          eventData: {
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-read-074",
                  name: "Read",
                  input: { file_path: "/tmp/toggle-test.txt" },
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
                  tool_use_id: "tu-read-074",
                  content: "file content here",
                  is_error: false,
                },
              ],
            },
            tool_use_result: { durationMs: 20, bytes: 17 },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
      ]),
    );

    const toolSummary = await waitFor(() => {
      const el = screen.getByTestId("tool-summary");
      expect(el).toBeInTheDocument();
      return el as HTMLDetailsElement;
    });

    // Initially closed (no search term)
    expect(toolSummary.open).toBeFalsy();

    const summary = toolSummary.querySelector("summary")!;

    // Click to expand
    click(summary);
    expect(toolSummary.open).toBeTruthy();

    // Click again to collapse
    click(summary);
    expect(toolSummary.open).toBeFalsy();
  });

  // ACT-D-075
  it("merges task_started and task_notification into a single Task card", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "system",
          eventData: {
            subtype: "task_started",
            task_id: "task-abc-075",
            tool_use_id: "tu-task-075",
            description: "Run sub-agent task 075",
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "system",
          eventData: {
            subtype: "task_notification",
            task_id: "task-abc-075",
            status: "completed",
            summary: "Task finished successfully",
          },
          createdAt: "2026-03-10T14:56:05Z",
        },
      ]),
    );

    // Should render exactly one "Task" card, not two
    await waitFor(() => {
      const taskCards = screen.getAllByText("Task");
      expect(taskCards).toHaveLength(1);
    });
  });

  // ACT-D-076
  it("absorbs task_progress heartbeats into the parent task row", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "system",
          eventData: {
            subtype: "task_started",
            task_id: "task-abc-076",
            tool_use_id: "tu-task-076",
            description: "Long running task 076",
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "system",
          eventData: {
            subtype: "task_progress",
            task_id: "task-abc-076",
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
        {
          sequenceNumber: 2,
          eventType: "system",
          eventData: {
            subtype: "task_progress",
            task_id: "task-abc-076",
          },
          createdAt: "2026-03-10T14:56:04Z",
        },
        {
          sequenceNumber: 3,
          eventType: "system",
          eventData: {
            subtype: "task_notification",
            task_id: "task-abc-076",
            status: "completed",
            summary: "Done",
          },
          createdAt: "2026-03-10T14:56:05Z",
        },
      ]),
    );

    // All three task events collapse to one "Task" card
    await waitFor(() => {
      const taskCards = screen.getAllByText("Task");
      expect(taskCards).toHaveLength(1);
    });
  });

  // ACT-D-077
  it("routes child assistant events into task childMessages and shows tool count", async () => {
    await renderInspectPage();
    await loadInspectData(
      makeInspectData([
        {
          sequenceNumber: 0,
          eventType: "system",
          eventData: {
            subtype: "task_started",
            task_id: "task-abc-077",
            tool_use_id: "tu-task-077",
            description: "Sub-agent with tools",
          },
          createdAt: "2026-03-10T14:56:02Z",
        },
        {
          sequenceNumber: 1,
          eventType: "assistant",
          eventData: {
            parent_tool_use_id: "tu-task-077",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tu-bash-077",
                  name: "Bash",
                  input: { command: "echo child-077" },
                },
              ],
            },
          },
          createdAt: "2026-03-10T14:56:03Z",
        },
        {
          sequenceNumber: 2,
          eventType: "system",
          eventData: {
            subtype: "task_notification",
            task_id: "task-abc-077",
            status: "completed",
            summary: "Done",
          },
          createdAt: "2026-03-10T14:56:04Z",
        },
      ]),
    );

    // Task card shows "1 steps" badge
    await waitFor(() => {
      expect(screen.getByText("1 steps")).toBeInTheDocument();
    });

    // Expand the task details to see child messages
    const taskHeading = screen.getByText("Task");
    const details = taskHeading.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    const summary = details.querySelector("summary")!;
    click(summary);

    // Child bash tool should appear inside
    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });
  });
});
