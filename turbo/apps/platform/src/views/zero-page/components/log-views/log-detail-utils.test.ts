import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";
import {
  groupEventsIntoMessages,
  groupedMessageKey,
  groupedMessageMatchesSearch,
} from "./log-detail-utils.ts";

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
