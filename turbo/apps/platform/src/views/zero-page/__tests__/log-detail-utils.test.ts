import { describe, expect, it } from "vitest";
import {
  groupEventsIntoMessages,
  groupedMessageMatchesSearch,
  type GroupedMessage,
} from "../components/log-views/log-detail-utils.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";

// LOG-D-001 — groupEventsIntoMessages and groupedMessageMatchesSearch unit tests

function makeEvent(
  seq: number,
  type: string,
  data: unknown,
  createdAt = "2026-04-13T10:00:00Z",
): AgentEvent {
  return {
    sequenceNumber: seq,
    eventType: type,
    eventData: data,
    createdAt,
  };
}

describe("groupEventsIntoMessages", () => {
  it("returns empty array for no events", () => {
    expect(groupEventsIntoMessages([])).toStrictEqual([]);
  });

  it("groups a standalone system event", () => {
    const events = [
      makeEvent(0, "system", { subtype: "init", tools: ["Bash", "Read"] }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe("system");
  });

  it("groups a standalone result event", () => {
    const events = [
      makeEvent(0, "result", { result: "Task completed", is_error: false }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe("result");
  });

  it("groups assistant text into a single message", () => {
    const events = [
      makeEvent(0, "assistant", {
        message: {
          content: [{ type: "text", text: "Here is my response." }],
        },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe("assistant");
    expect(grouped[0].textBefore).toBe("Here is my response.");
  });

  it("merges tool-only assistant event into previous assistant message", () => {
    const events = [
      makeEvent(0, "assistant", {
        message: {
          content: [{ type: "text", text: "Let me check." }],
        },
      }),
      makeEvent(1, "assistant", {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    // Merged into one card
    expect(grouped).toHaveLength(1);
    expect(grouped[0].textBefore).toBe("Let me check.");
    expect(grouped[0].toolOperations).toHaveLength(1);
    expect(grouped[0].toolOperations?.[0].toolName).toBe("Bash");
  });

  it("links tool_result to matching tool_use via toolUseId", () => {
    const events = [
      makeEvent(0, "assistant", {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-bash-1",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
        },
      }),
      makeEvent(1, "user", {
        tool_use_result: { durationMs: 50, bytes: 12 },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-bash-1",
              content: "hello\n",
              is_error: false,
            },
          ],
        },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    const op = grouped[0].toolOperations?.[0];
    expect(op?.result?.content).toBe("hello\n");
    expect(op?.result?.durationMs).toBe(50);
    expect(op?.result?.isError).toBeFalsy();
  });

  it("merges task_started and task_notification into a single message", () => {
    const events = [
      makeEvent(0, "system", {
        subtype: "task_started",
        task_id: "task-123",
        tool_use_id: "tu-task-1",
        description: "Run sub-agent",
      }),
      makeEvent(1, "system", {
        subtype: "task_notification",
        task_id: "task-123",
        status: "completed",
        summary: "Sub-agent finished",
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe("system");

    const data = grouped[0].eventData as {
      task_status?: string;
      task_summary?: string;
    };
    expect(data.task_status).toBe("completed");
    expect(data.task_summary).toBe("Sub-agent finished");
  });

  it("absorbs task_progress heartbeats into the parent task row", () => {
    const events = [
      makeEvent(0, "system", {
        subtype: "task_started",
        task_id: "task-p",
        tool_use_id: "tu-task-p",
        description: "Long running task",
      }),
      makeEvent(1, "system", {
        subtype: "task_progress",
        task_id: "task-p",
      }),
      makeEvent(2, "system", {
        subtype: "task_progress",
        task_id: "task-p",
      }),
      makeEvent(3, "system", {
        subtype: "task_notification",
        task_id: "task-p",
        status: "completed",
        summary: "Done",
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    // All four events collapse to one row
    expect(grouped).toHaveLength(1);
  });

  it("routes child assistant events to task childMessages via parent_tool_use_id", () => {
    const events = [
      makeEvent(0, "system", {
        subtype: "task_started",
        task_id: "task-child",
        tool_use_id: "tu-parent",
        description: "Sub-agent task",
      }),
      makeEvent(1, "assistant", {
        parent_tool_use_id: "tu-parent",
        message: {
          content: [{ type: "text", text: "Child output" }],
        },
      }),
      makeEvent(2, "system", {
        subtype: "task_notification",
        task_id: "task-child",
        status: "completed",
        summary: "Done",
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].childMessages).toHaveLength(1);
    expect(grouped[0].childMessages?.[0].textBefore).toBe("Child output");
  });

  it("handles orphan task_notification (no matching task_started) as standalone", () => {
    const events = [
      makeEvent(0, "system", {
        subtype: "task_notification",
        task_id: "task-orphan",
        status: "completed",
        summary: "Orphan notification",
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
    expect(grouped[0].type).toBe("system");
  });

  it("deduplicates events with the same sequenceNumber", () => {
    const events = [
      makeEvent(0, "assistant", {
        message: { content: [{ type: "text", text: "First" }] },
      }),
      makeEvent(0, "assistant", {
        message: { content: [{ type: "text", text: "Duplicate" }] },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    expect(grouped).toHaveLength(1);
  });

  it("sorts events by sequenceNumber before grouping", () => {
    const events = [
      makeEvent(2, "result", { result: "Done" }),
      makeEvent(1, "system", { subtype: "init" }),
    ];
    const grouped = groupEventsIntoMessages(events);

    // After sorting: seq 1 (system) first, seq 2 (result) second
    expect(grouped).toHaveLength(2);
    expect(grouped[0].type).toBe("system");
    expect(grouped[1].type).toBe("result");
  });

  it("creates a todo card for TodoWrite operations", () => {
    const events = [
      makeEvent(0, "assistant", {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-todo",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Step one", status: "in_progress" },
                  { content: "Step two", status: "pending" },
                ],
              },
            },
          ],
        },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);

    const todoCard = grouped.find((m) => m.type === "todo");
    expect(todoCard).toBeDefined();
    expect(todoCard?.todoState).toHaveLength(2);
    expect(todoCard?.todoState?.[0].content).toBe("Step one");
  });

  it("extracts keyParam for Bash command", () => {
    const events = [
      makeEvent(0, "assistant", {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-b",
              name: "Bash",
              input: { command: "echo hello" },
            },
          ],
        },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);
    const op = grouped[0].toolOperations?.[0];

    expect(op?.keyParam).toBe("echo hello");
  });

  it("truncates long Bash commands at 60 chars", () => {
    const longCmd = "a".repeat(70);
    const events = [
      makeEvent(0, "assistant", {
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-b2",
              name: "Bash",
              input: { command: longCmd },
            },
          ],
        },
      }),
    ];
    const grouped = groupEventsIntoMessages(events);
    const op = grouped[0].toolOperations?.[0];

    expect(op?.keyParam).toHaveLength(60);
    expect(op?.keyParam?.endsWith("...")).toBeTruthy();
  });
});

describe("groupedMessageMatchesSearch", () => {
  function makeGrouped(overrides: Partial<GroupedMessage>): GroupedMessage {
    return {
      type: "assistant",
      sequenceNumber: 0,
      createdAt: "2026-04-13T10:00:00Z",
      eventData: {},
      ...overrides,
    };
  }

  it("matches when search term is empty", () => {
    const msg = makeGrouped({ textBefore: "some text" });
    expect(groupedMessageMatchesSearch(msg, "")).toBeTruthy();
  });

  it("matches when search term is whitespace only", () => {
    const msg = makeGrouped({ textBefore: "some text" });
    expect(groupedMessageMatchesSearch(msg, "   ")).toBeTruthy();
  });

  it("matches textBefore content", () => {
    const msg = makeGrouped({ textBefore: "Here is the plan" });
    expect(groupedMessageMatchesSearch(msg, "plan")).toBeTruthy();
    expect(groupedMessageMatchesSearch(msg, "xyz")).toBeFalsy();
  });

  it("matches tool name in toolOperations", () => {
    const msg = makeGrouped({
      toolOperations: [
        {
          toolUseId: "tu-1",
          toolName: "WebFetch",
          keyParam: "https://example.com",
          input: {},
        },
      ],
    });
    expect(groupedMessageMatchesSearch(msg, "webfetch")).toBeTruthy();
    expect(groupedMessageMatchesSearch(msg, "example.com")).toBeTruthy();
  });

  it("matches tool result content", () => {
    const msg = makeGrouped({
      toolOperations: [
        {
          toolUseId: "tu-2",
          toolName: "Bash",
          keyParam: "ls",
          input: {},
          result: { content: "file1.txt\nfile2.txt", isError: false },
        },
      ],
    });
    expect(groupedMessageMatchesSearch(msg, "file1.txt")).toBeTruthy();
  });

  it("matches system event subtype", () => {
    const msg = makeGrouped({
      type: "system",
      eventData: { subtype: "init", tools: ["Bash"] },
    });
    expect(groupedMessageMatchesSearch(msg, "init")).toBeTruthy();
  });

  it("matches task description in system task events", () => {
    const msg = makeGrouped({
      type: "system",
      eventData: {
        subtype: "task_started",
        task_id: "task-abc",
        tool_use_id: "tu-x",
        description: "Run database migration",
      },
    });
    expect(groupedMessageMatchesSearch(msg, "database migration")).toBeTruthy();
    expect(groupedMessageMatchesSearch(msg, "cache")).toBeFalsy();
  });

  it("is case insensitive", () => {
    const msg = makeGrouped({ textBefore: "Hello World" });
    expect(groupedMessageMatchesSearch(msg, "hello")).toBeTruthy();
    expect(groupedMessageMatchesSearch(msg, "WORLD")).toBeTruthy();
  });

  it("matches result event content", () => {
    const msg = makeGrouped({
      type: "result",
      eventData: { result: "Task finished successfully" },
    });
    expect(groupedMessageMatchesSearch(msg, "successfully")).toBeTruthy();
  });
});
