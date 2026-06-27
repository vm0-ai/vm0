import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";
import {
  groupEventsIntoMessages,
  groupedMessageKey,
  groupedMessageMatchesSearch,
} from "./log-detail-utils.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("groupEventsIntoMessages progress events", () => {
  it("filters Claude Code thinking token progress events", () => {
    const events: AgentEvent[] = [
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          type: "system",
          subtype: "init",
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 1,
        eventType: "system",
        eventData: {
          type: "system",
          subtype: "thinking_tokens",
        },
        createdAt: "2026-06-26T02:31:26Z",
      },
      {
        sequenceNumber: 2,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Actual assistant output." }],
          },
        },
        createdAt: "2026-06-26T02:31:28Z",
      },
    ];

    const messages = groupEventsIntoMessages(events);

    expect(messages).toHaveLength(2);
    expect(
      messages.map((message) => {
        return message.eventData;
      }),
    ).toEqual([
      { type: "system", subtype: "init" },
      {
        message: {
          content: [{ type: "text", text: "Actual assistant output." }],
        },
      },
    ]);
  });

  it("keeps Codex reasoning text visible", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "item.completed",
        eventData: {
          type: "item.completed",
          item: {
            type: "reasoning",
            text: "Consider the failing branch before editing.",
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.textBefore).toBe(
      "[thinking] Consider the failing branch before editing.",
    );
  });
});

describe("groupEventsIntoMessages Codex turn completion signals", () => {
  it("keeps top-level success false even when nested turn status is completed", () => {
    const messages = groupEventsIntoMessages(
      [
        {
          sequenceNumber: 0,
          eventType: "turn.completed",
          eventData: {
            type: "turn.completed",
            success: false,
            turn: {
              id: "turn-conflicting-success",
              success: true,
              status: "completed",
            },
          },
          createdAt: "2026-06-26T02:31:20Z",
        },
      ],
      { framework: "codex" },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("result");
    expect(messages[0]?.eventData).toMatchObject({
      is_error: true,
      result: "Turn failed",
    });
  });

  it("keeps top-level failed status even when nested turn status is completed", () => {
    const messages = groupEventsIntoMessages(
      [
        {
          sequenceNumber: 0,
          eventType: "turn.completed",
          eventData: {
            type: "turn.completed",
            status: "failed",
            turn: {
              id: "turn-conflicting-status",
              status: "completed",
            },
          },
          createdAt: "2026-06-26T02:31:20Z",
        },
      ],
      { framework: "codex" },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("result");
    expect(messages[0]?.eventData).toMatchObject({
      is_error: true,
      result: "Turn failed",
    });
  });
});

describe("groupEventsIntoMessages Codex plan events", () => {
  it("drops empty Codex plan updates", () => {
    const messages = groupEventsIntoMessages(
      [
        {
          sequenceNumber: 0,
          eventType: "turn.plan.updated",
          eventData: {
            type: "turn.plan.updated",
            plan: [{ status: "pending" }, null],
          },
          createdAt: "2026-06-26T02:31:20Z",
        },
      ],
      { framework: "codex" },
    );

    expect(messages).toEqual([]);
  });

  it("keeps Codex plan updates with content", () => {
    const messages = groupEventsIntoMessages(
      [
        {
          sequenceNumber: 0,
          eventType: "turn.plan.updated",
          eventData: {
            type: "turn.plan.updated",
            explanation: "Review edge cases",
            plan: [{ status: "in_progress", step: "Check empty plans" }],
          },
          createdAt: "2026-06-26T02:31:20Z",
        },
      ],
      { framework: "codex" },
    );

    expect(messages[0]?.textBefore).toBe(
      "[plan]\nReview edge cases\n- in progress: Check empty plans",
    );
  });

  it("bounds Codex plan updates with many visible steps", () => {
    const messages = groupEventsIntoMessages(
      [
        {
          sequenceNumber: 0,
          eventType: "turn.plan.updated",
          eventData: {
            type: "turn.plan.updated",
            plan: Array.from({ length: 25 }, (_, index) => {
              return {
                status: "pending",
                step: `Step ${index}`,
              };
            }),
          },
          createdAt: "2026-06-26T02:31:20Z",
        },
      ],
      { framework: "codex" },
    );

    expect(messages[0]?.textBefore).toContain("- pending: Step 19");
    expect(messages[0]?.textBefore).not.toContain("- pending: Step 20");
    expect(messages[0]?.textBefore).toContain("- ... +5 more steps");
  });
});

describe("groupEventsIntoMessages Codex file changes", () => {
  it("bounds Codex file change output with many changes", () => {
    const messages = groupEventsIntoMessages(
      [
        {
          sequenceNumber: 0,
          eventType: "item.completed",
          eventData: {
            type: "item.completed",
            item: {
              id: "files-many",
              type: "file_change",
              changes: Array.from({ length: 25 }, (_, index) => {
                return {
                  kind: "modify",
                  path: `src/file-${index}.ts`,
                };
              }),
            },
          },
          createdAt: "2026-06-26T02:31:20Z",
        },
      ],
      { framework: "codex" },
    );

    expect(messages[0]?.textBefore).toContain("- modify src/file-19.ts");
    expect(messages[0]?.textBefore).not.toContain("- modify src/file-20.ts");
    expect(messages[0]?.textBefore).toContain("- ... +5 more changes");
  });
});

describe("groupEventsIntoMessages unserializable event data", () => {
  it("does not throw when same-sequence event data contains cycles", () => {
    const circularEventData: Record<string, unknown> = {
      message: {
        content: [{ type: "text", text: "Circular same-sequence event." }],
      },
    };
    circularEventData.self = circularEventData;

    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 3,
        eventType: "assistant",
        eventData: circularEventData,
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 3,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Second same-sequence event." }],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return message.textBefore;
      }),
    ).toEqual(["Circular same-sequence event.", "Second same-sequence event."]);
  });
});

describe("groupEventsIntoMessages event dedupe", () => {
  it("keeps distinct events that share a sequence number", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 3,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "First same-sequence event." }],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 3,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Second same-sequence event." }],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return message.textBefore;
      }),
    ).toEqual(["First same-sequence event.", "Second same-sequence event."]);
    expect(
      new Set(
        messages.map((message) => {
          return message.sequenceNumber;
        }),
      ).size,
    ).toBe(2);
    expect(
      new Set(
        messages.map((message) => {
          return groupedMessageKey(message);
        }),
      ).size,
    ).toBe(2);
  });

  it("dedupes exact repeated events", () => {
    const duplicateEvent: AgentEvent = {
      sequenceNumber: 4,
      eventType: "assistant",
      eventData: {
        message: {
          content: [{ type: "text", text: "Repeated boundary event." }],
        },
      },
      createdAt: "2026-06-26T02:31:21Z",
    };

    const messages = groupEventsIntoMessages([
      duplicateEvent,
      { ...duplicateEvent },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.textBefore).toBe("Repeated boundary event.");
  });

  it("keeps fallback tool ids unique for same-sequence events", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 5,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "echo first" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 5,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "echo second" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
    ]);

    const toolUseIds = messages.flatMap((message) => {
      return (
        message.toolOperations?.map((operation) => {
          return operation.toolUseId;
        }) ?? []
      );
    });

    expect(new Set(toolUseIds).size).toBe(2);
  });
});

describe("groupEventsIntoMessages sequence ordering", () => {
  it("keeps same-sequence events before the next fractional sequence", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 5,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "First duplicate sequence." }],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 5,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Second duplicate sequence." }],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 5.0005,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Next fractional sequence." }],
          },
        },
        createdAt: "2026-06-26T02:31:23Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return message.textBefore;
      }),
    ).toEqual([
      "First duplicate sequence.",
      "Second duplicate sequence.",
      "Next fractional sequence.",
    ]);
    expect(messages[1]?.sequenceNumber).toBeGreaterThan(5);
    expect(messages[1]?.sequenceNumber).toBeLessThan(5.0005);
  });
});

describe("groupEventsIntoMessages split sequence ordering", () => {
  it("keeps split orphan tool results before the next fractional sequence", () => {
    const nextSequenceNumber = 9.000_001;
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 9,
        eventType: "user",
        eventData: {
          message: {
            content: [
              { type: "tool_result", content: "first orphan" },
              { type: "tool_result", content: "second orphan" },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: nextSequenceNumber,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Next fractional sequence." }],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return (
          message.textBefore ?? message.toolOperations?.[0]?.result?.content
        );
      }),
    ).toEqual(["first orphan", "second orphan", "Next fractional sequence."]);
    expect(messages[0]?.sequenceNumber).toBeGreaterThan(9);
    expect(messages[1]?.sequenceNumber).toBeGreaterThan(
      messages[0]?.sequenceNumber ?? 9,
    );
    expect(messages[1]?.sequenceNumber).toBeLessThan(nextSequenceNumber);
    expect(messages[2]?.sequenceNumber).toBe(nextSequenceNumber);
  });

  it("keeps split TodoWrite cards before the next fractional sequence", () => {
    const nextSequenceNumber = 7.000_001;
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 7,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-before-next-1",
                name: "TodoWrite",
                input: {
                  todos: [{ content: "First task", status: "in_progress" }],
                },
              },
              {
                type: "tool_use",
                id: "todo-before-next-2",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "First task", status: "completed" },
                    { content: "Second task", status: "in_progress" },
                  ],
                },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: nextSequenceNumber,
        eventType: "assistant",
        eventData: {
          message: {
            content: [{ type: "text", text: "Next fractional sequence." }],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return message.type === "todo"
          ? message.todoState?.at(-1)?.content
          : message.textBefore;
      }),
    ).toEqual(["First task", "Second task", "Next fractional sequence."]);
    expect(messages[0]?.sequenceNumber).toBeGreaterThan(7);
    expect(messages[1]?.sequenceNumber).toBeGreaterThan(
      messages[0]?.sequenceNumber ?? 7,
    );
    expect(messages[1]?.sequenceNumber).toBeLessThan(nextSequenceNumber);
    expect(messages[2]?.sequenceNumber).toBe(nextSequenceNumber);
  });
});

describe("groupEventsIntoMessages task event data", () => {
  it("does not treat task_started status as a terminal task status", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-started",
          status: "running",
          description: "Started task",
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
    ]);

    const taskMessage = messages[0];
    if (!taskMessage || !isRecord(taskMessage.eventData)) {
      throw new Error("expected task started message");
    }

    expect(taskMessage.eventData.status).toBe("running");
    expect(taskMessage.eventData.task_status).toBeUndefined();
  });

  it("keeps orphan task notification status and summary searchable", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_notification",
          task_id: "orphan-task",
          status: "completed",
          summary: "Orphan task finished",
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
    ]);

    const taskMessage = messages[0];
    if (!taskMessage || !isRecord(taskMessage.eventData)) {
      throw new Error("expected task notification message");
    }

    expect(taskMessage.eventData.task_status).toBe("completed");
    expect(taskMessage.eventData.task_summary).toBe("Orphan task finished");
    expect(groupedMessageMatchesSearch(taskMessage, "orphan task")).toBe(true);
    expect(groupedMessageMatchesSearch(taskMessage, " orphan task ")).toBe(
      true,
    );
  });

  it("merges task notifications that already use task status fields", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-1",
          tool_use_id: "task-tool-1",
          description: "Parent task",
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 1,
        eventType: "system",
        eventData: {
          subtype: "task_notification",
          task_id: "task-1",
          task_status: "completed",
          task_summary: "Task finished through normalized fields",
        },
        createdAt: "2026-06-26T02:31:23Z",
      },
    ]);

    const taskMessage = messages[0];
    if (!taskMessage || !isRecord(taskMessage.eventData)) {
      throw new Error("expected merged task message");
    }

    expect(messages).toHaveLength(1);
    expect(taskMessage.eventData.task_status).toBe("completed");
    expect(taskMessage.eventData.task_summary).toBe(
      "Task finished through normalized fields",
    );
  });

  it("ignores task progress that arrives after completion", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-1",
          tool_use_id: "task-tool-1",
          description: "Parent task",
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 1,
        eventType: "system",
        eventData: {
          subtype: "task_notification",
          task_id: "task-1",
          status: "completed",
          summary: "Task finished",
        },
        createdAt: "2026-06-26T02:31:23Z",
      },
      {
        sequenceNumber: 2,
        eventType: "system",
        eventData: {
          subtype: "task_progress",
          task_id: "task-1",
        },
        createdAt: "2026-06-26T02:31:24Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("system");
  });
});

describe("groupedMessageMatchesSearch", () => {
  it("matches text nested in task child messages", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-1",
          tool_use_id: "task-tool-1",
          description: "Parent task",
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          parent_tool_use_id: "task-tool-1",
          message: {
            content: [{ type: "text", text: "Nested child output." }],
          },
        },
        createdAt: "2026-06-26T02:31:23Z",
      },
    ]);

    const taskMessage = messages[0];
    if (!taskMessage) {
      throw new Error("expected task message");
    }

    expect(taskMessage.childMessages?.[0]?.textBefore).toBe(
      "Nested child output.",
    );
    expect(groupedMessageMatchesSearch(taskMessage, "nested child")).toBe(true);
    expect(groupedMessageMatchesSearch(taskMessage, "missing text")).toBe(
      false,
    );
  });

  it("matches todo item content", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-1",
                name: "TodoWrite",
                input: {
                  todos: [
                    {
                      content: "Investigate sandbox retry",
                      status: "in_progress",
                    },
                  ],
                },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
    ]);

    const todoMessage = messages[0];
    if (!todoMessage) {
      throw new Error("expected todo message");
    }

    expect(groupedMessageMatchesSearch(todoMessage, "sandbox retry")).toBe(
      true,
    );
    expect(groupedMessageMatchesSearch(todoMessage, "missing text")).toBe(
      false,
    );
  });
});

describe("groupEventsIntoMessages duplicate tool ids", () => {
  it("matches child tool results by parent task when tool ids repeat", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-a",
          tool_use_id: "task-tool-a",
          description: "Task A",
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 1,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-b",
          tool_use_id: "task-tool-b",
          description: "Task B",
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
      {
        sequenceNumber: 2,
        eventType: "assistant",
        eventData: {
          parent_tool_use_id: "task-tool-a",
          message: {
            content: [
              {
                type: "tool_use",
                id: "shared-tool-id",
                name: "Bash",
                input: { command: "echo task-a" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
      {
        sequenceNumber: 3,
        eventType: "assistant",
        eventData: {
          parent_tool_use_id: "task-tool-b",
          message: {
            content: [
              {
                type: "tool_use",
                id: "shared-tool-id",
                name: "Bash",
                input: { command: "echo task-b" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:23Z",
      },
      {
        sequenceNumber: 4,
        eventType: "user",
        eventData: {
          parent_tool_use_id: "task-tool-a",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "shared-tool-id",
                content: "result task-a",
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:24Z",
      },
      {
        sequenceNumber: 5,
        eventType: "user",
        eventData: {
          parent_tool_use_id: "task-tool-b",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "shared-tool-id",
                content: "result task-b",
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:25Z",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]?.childMessages).toHaveLength(1);
    expect(messages[1]?.childMessages).toHaveLength(1);
    expect(
      messages[0]?.childMessages?.[0]?.toolOperations?.[0]?.result?.content,
    ).toBe("result task-a");
    expect(
      messages[1]?.childMessages?.[0]?.toolOperations?.[0]?.result?.content,
    ).toBe("result task-b");
  });
});

describe("groupEventsIntoMessages parent tool ids", () => {
  it("does not attach child tool results to a mismatched parent task", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "system",
        eventData: {
          subtype: "task_started",
          task_id: "task-a",
          tool_use_id: "task-tool-a",
          description: "Task A",
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          parent_tool_use_id: "task-tool-a",
          message: {
            content: [
              {
                type: "tool_use",
                id: "shared-tool-id",
                name: "Bash",
                input: { command: "echo task-a" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
      {
        sequenceNumber: 2,
        eventType: "user",
        eventData: {
          parent_tool_use_id: "missing-task",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "shared-tool-id",
                content: "wrong parent result",
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:22Z",
      },
    ]);

    expect(messages).toHaveLength(2);
    expect(
      messages[0]?.childMessages?.[0]?.toolOperations?.[0]?.result,
    ).toBeUndefined();
    expect(messages[1]?.toolOperations?.[0]).toMatchObject({
      toolName: "Unknown",
      result: {
        content: "wrong parent result",
        isError: false,
      },
    });
  });
});

describe("groupEventsIntoMessages thinking content", () => {
  it("keeps Claude Code thinking content blocks visible", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "thinking",
                thinking: "Review the failing logs before responding.",
              },
              { type: "text", text: "The failure is in the log renderer." },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.thinkingBlocks).toEqual([
      "Review the failing logs before responding.",
    ]);
    expect(messages[0]?.textBefore).toBe("The failure is in the log renderer.");
  });

  it("does not drop thinking-only assistant events", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 0,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "thinking",
                thinking: "Inspect the previous run output.",
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.thinkingBlocks).toEqual([
      "Inspect the previous run output.",
    ]);
    expect(messages[0]?.textBefore).toBeUndefined();
  });
});

describe("groupEventsIntoMessages malformed tool ids", () => {
  it("uses stable fallback ids for tool uses without ids", () => {
    const events: AgentEvent[] = [
      {
        sequenceNumber: 4,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: "echo stable" },
              },
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "src/stable.ts" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ];

    const firstMessages = groupEventsIntoMessages(events);
    const secondMessages = groupEventsIntoMessages(events);

    expect(
      firstMessages[0]?.toolOperations?.map((operation) => {
        return operation.toolUseId;
      }),
    ).toEqual(["unknown-4-0", "unknown-4-1"]);
    expect(secondMessages[0]?.toolOperations).toEqual(
      firstMessages[0]?.toolOperations,
    );
  });

  it("keeps multiple orphan tool results from one event addressable", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 9,
        eventType: "user",
        eventData: {
          message: {
            content: [
              { type: "tool_result", content: "first orphan" },
              { type: "tool_result", content: "second orphan" },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return message.sequenceNumber;
      }),
    ).toEqual([9 + 1 / 1_000_000, 9 + 2 / 1_000_000]);
    expect(
      messages.map((message) => {
        return message.toolOperations?.[0]?.toolUseId;
      }),
    ).toEqual(["orphan-9-0", "orphan-9-1"]);
  });

  it("keeps multiple TodoWrite cards from one event addressable", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 7,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-1",
                name: "TodoWrite",
                input: {
                  todos: [{ content: "First task", status: "in_progress" }],
                },
              },
              {
                type: "tool_use",
                id: "todo-2",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "First task", status: "completed" },
                    { content: "Second task", status: "in_progress" },
                  ],
                },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(
      messages.map((message) => {
        return message.sequenceNumber;
      }),
    ).toEqual([7 + 1 / 1_000_000, 7 + 2 / 1_000_000]);
    expect(
      new Set(
        messages.map((message) => {
          return groupedMessageKey(message);
        }),
      ).size,
    ).toBe(2);
    expect(messages[0]?.todoState).toEqual([
      { content: "First task", status: "in_progress" },
    ]);
    expect(messages[1]?.todoState).toEqual([
      { content: "First task", status: "completed" },
      { content: "Second task", status: "in_progress" },
    ]);
  });
});

describe("groupEventsIntoMessages tool result metadata", () => {
  it("normalizes tool result content that JSON.stringify cannot handle", () => {
    const circularContent: Record<string, unknown> = { output: "done" };
    circularContent.self = circularContent;

    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-circular-content",
                name: "Bash",
                input: { command: "echo circular" },
              },
              {
                type: "tool_use",
                id: "tool-bigint-content",
                name: "Bash",
                input: { command: "echo bigint" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 2,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-circular-content",
                content: circularContent,
              },
              {
                type: "tool_result",
                tool_use_id: "tool-bigint-content",
                content: BigInt(42),
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(messages[0]?.toolOperations?.[0]?.result?.content).toBe(
      '{"output":"done","self":"[Circular]"}',
    );
    expect(messages[0]?.toolOperations?.[1]?.result?.content).toBe("42");
  });

  it("bounds deeply nested and sparse tool result content", () => {
    let deepContent: Record<string, unknown> = { leaf: "done" };
    for (let i = 0; i < 80; i += 1) {
      deepContent = { next: deepContent };
    }
    const sparseContent: unknown[] = [];
    sparseContent.length = 10_000;

    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-deep-content",
                name: "Bash",
                input: { command: "echo deep" },
              },
              {
                type: "tool_use",
                id: "tool-sparse-content",
                name: "Bash",
                input: { command: "echo sparse" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 2,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-deep-content",
                content: deepContent,
              },
              {
                type: "tool_result",
                tool_use_id: "tool-sparse-content",
                content: sparseContent,
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(messages[0]?.toolOperations?.[0]?.result?.content).toContain(
      '"[MaxDepth]"',
    );
    expect(messages[0]?.toolOperations?.[1]?.result?.content).toContain(
      '"... 9900 more items"',
    );
  });
});

describe("groupEventsIntoMessages tool result metadata validation", () => {
  it("ignores negative tool result duration and bytes", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 1,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool-negative-meta",
                name: "Bash",
                input: { command: "echo meta" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 2,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-negative-meta",
                content: "done",
              },
            ],
          },
          tool_use_result: { durationMs: -5, bytes: -10 },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(messages[0]?.toolOperations?.[0]?.result).toMatchObject({
      content: "done",
      isError: false,
    });
    expect(
      messages[0]?.toolOperations?.[0]?.result?.durationMs,
    ).toBeUndefined();
    expect(messages[0]?.toolOperations?.[0]?.result?.bytes).toBeUndefined();
  });
});

describe("groupEventsIntoMessages malformed TodoWrite values", () => {
  it("uses a safe fallback for malformed todo values", () => {
    const malformedTodo = Object.create(null) as Record<string, unknown>;
    malformedTodo.toJSON = () => {
      throw new Error("cannot serialize todo");
    };

    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 7,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-malformed-item",
                name: "TodoWrite",
                input: { todos: [malformedTodo] },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
    ]);

    expect(messages[0]?.todoState).toEqual([
      { content: "{}", status: "pending" },
    ]);
  });
});

describe("groupEventsIntoMessages TodoWrite snapshots", () => {
  it("renders malformed TodoWrite calls as ordinary tools", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 7,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-bad",
                name: "TodoWrite",
                input: { todos: "not-an-array" },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 8,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "todo-bad",
                content: "invalid todo payload",
                is_error: true,
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("assistant");
    expect(messages[0]?.todoState).toBeUndefined();
    expect(messages[0]?.toolOperations?.[0]).toMatchObject({
      toolName: "TodoWrite",
      result: {
        content: "invalid todo payload",
        isError: true,
      },
    });
  });

  it("keeps TodoWrite errors attached to todo cards", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 7,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-error",
                name: "TodoWrite",
                input: {
                  todos: [{ content: "Check failure", status: "pending" }],
                },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 8,
        eventType: "user",
        eventData: {
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "todo-error",
                content: "todo write failed",
                is_error: true,
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(messages).toHaveLength(1);
    const [message] = messages;
    if (!message) {
      throw new Error("expected todo message");
    }

    expect(message.type).toBe("todo");
    expect(message.todoState).toEqual([
      { content: "Check failure", status: "pending" },
    ]);
    expect(message.toolOperations?.[0]).toMatchObject({
      toolName: "TodoWrite",
      result: {
        content: "todo write failed",
        isError: true,
      },
    });
    expect(groupedMessageMatchesSearch(message, "todo write failed")).toBe(
      true,
    );
    expect(groupedMessageMatchesSearch(message, "TodoWrite")).toBe(false);
  });
});

describe("groupEventsIntoMessages TodoWrite state", () => {
  it("treats TodoWrite input as the latest ordered todo snapshot", () => {
    const messages = groupEventsIntoMessages([
      {
        sequenceNumber: 7,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-1",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Duplicate task", status: "pending" },
                    { content: "Duplicate task", status: "in_progress" },
                    { content: "Removed task", status: "pending" },
                  ],
                },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:20Z",
      },
      {
        sequenceNumber: 8,
        eventType: "assistant",
        eventData: {
          message: {
            content: [
              {
                type: "tool_use",
                id: "todo-2",
                name: "TodoWrite",
                input: {
                  todos: [
                    { content: "Duplicate task", status: "completed" },
                    { content: "Duplicate task", status: "in_progress" },
                  ],
                },
              },
            ],
          },
        },
        createdAt: "2026-06-26T02:31:21Z",
      },
    ]);

    expect(messages[0]?.todoState).toEqual([
      { content: "Duplicate task", status: "pending" },
      { content: "Duplicate task", status: "in_progress" },
      { content: "Removed task", status: "pending" },
    ]);
    expect(messages[1]?.todoState).toEqual([
      { content: "Duplicate task", status: "completed" },
      { content: "Duplicate task", status: "in_progress" },
    ]);
  });
});
