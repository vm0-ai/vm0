import { beforeAll, describe, expect, it } from "vitest";

import { initializeI18n } from "../../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../../i18n/resources.ts";
import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";
import {
  groupEventsIntoGroups,
  eventGroupKey,
  eventGroupMatchesSearch,
} from "./log-detail-utils.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

beforeAll(async () => {
  await initializeI18n(DEFAULT_LOCALE);
});

describe("groupEventsIntoGroups progress events", () => {
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

    const groups = groupEventsIntoGroups(events);

    expect(groups).toHaveLength(2);
    expect(
      groups.map((group) => {
        return group.eventData;
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
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.textBefore).toBe(
      "[thinking] Consider the failing branch before editing.",
    );
  });
});

describe("groupEventsIntoGroups Codex turn completion signals", () => {
  it("keeps top-level success false even when nested turn status is completed", () => {
    const groups = groupEventsIntoGroups(
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("result");
    expect(groups[0]?.eventData).toMatchObject({
      is_error: true,
      result: "Turn failed",
    });
  });

  it("keeps top-level failed status even when nested turn status is completed", () => {
    const groups = groupEventsIntoGroups(
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("result");
    expect(groups[0]?.eventData).toMatchObject({
      is_error: true,
      result: "Turn failed",
    });
  });
});

describe("groupEventsIntoGroups Codex plan events", () => {
  it("drops empty Codex plan updates", () => {
    const groups = groupEventsIntoGroups(
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

    expect(groups).toEqual([]);
  });

  it("keeps Codex plan updates with content", () => {
    const groups = groupEventsIntoGroups(
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

    expect(groups[0]?.textBefore).toBe(
      "[plan]\nReview edge cases\n- in progress: Check empty plans",
    );
  });

  it("bounds Codex plan updates with many visible steps", () => {
    const groups = groupEventsIntoGroups(
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

    expect(groups[0]?.textBefore).toContain("- pending: Step 19");
    expect(groups[0]?.textBefore).not.toContain("- pending: Step 20");
    expect(groups[0]?.textBefore).toContain("- ... +5 more steps");
  });
});

describe("groupEventsIntoGroups Codex file changes", () => {
  it("bounds Codex file change output with many changes", () => {
    const groups = groupEventsIntoGroups(
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

    expect(groups[0]?.textBefore).toContain("- modify src/file-19.ts");
    expect(groups[0]?.textBefore).not.toContain("- modify src/file-20.ts");
    expect(groups[0]?.textBefore).toContain("- ... +5 more changes");
  });
});

describe("groupEventsIntoGroups unserializable event data", () => {
  it("does not throw when same-sequence event data contains cycles", () => {
    const circularEventData: Record<string, unknown> = {
      message: {
        content: [{ type: "text", text: "Circular same-sequence event." }],
      },
    };
    circularEventData.self = circularEventData;

    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.textBefore;
      }),
    ).toEqual(["Circular same-sequence event.", "Second same-sequence event."]);
  });
});

describe("groupEventsIntoGroups event dedupe", () => {
  it("keeps distinct events that share a sequence number", () => {
    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.textBefore;
      }),
    ).toEqual(["First same-sequence event.", "Second same-sequence event."]);
    expect(
      new Set(
        groups.map((group) => {
          return group.sequenceNumber;
        }),
      ).size,
    ).toBe(2);
    expect(
      new Set(
        groups.map((group) => {
          return eventGroupKey(group);
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

    const groups = groupEventsIntoGroups([
      duplicateEvent,
      { ...duplicateEvent },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.textBefore).toBe("Repeated boundary event.");
  });

  it("keeps same-sequence events that differ after display truncation limits", () => {
    const largePayload = (marker: string): Record<string, string> => {
      const payload: Record<string, string> = {};
      for (let index = 0; index < 100; index += 1) {
        payload[`field-${index}`] = "same";
      }
      payload["field-after-truncation-limit"] = marker;
      return payload;
    };
    const baseEvent = {
      sequenceNumber: 4,
      eventType: "assistant",
      createdAt: "2026-06-26T02:31:21Z",
      eventData: {
        message: {
          content: [{ type: "text", text: "Repeated visible text." }],
        },
      },
    } satisfies AgentEvent;

    const groups = groupEventsIntoGroups([
      {
        ...baseEvent,
        eventData: {
          ...baseEvent.eventData,
          payload: largePayload("first"),
        },
      },
      {
        ...baseEvent,
        eventData: {
          ...baseEvent.eventData,
          payload: largePayload("second"),
        },
      },
    ]);

    expect(groups).toHaveLength(2);
  });
});

describe("groupEventsIntoGroups event dedupe edge cases", () => {
  it("keeps too-deep same-sequence events instead of lossy deduping", () => {
    const deepPayload = (): unknown => {
      let value: unknown = "leaf";
      for (let depth = 0; depth < 80; depth += 1) {
        value = { value };
      }
      return value;
    };
    const event = {
      sequenceNumber: 4,
      eventType: "assistant",
      createdAt: "2026-06-26T02:31:21Z",
      eventData: {
        message: {
          content: [{ type: "text", text: "Repeated visible text." }],
        },
        payload: deepPayload(),
      },
    } satisfies AgentEvent;

    const groups = groupEventsIntoGroups([event, event]);

    expect(groups).toHaveLength(2);
  });

  it("keeps fallback tool ids unique for same-sequence events", () => {
    const groups = groupEventsIntoGroups([
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

    const toolUseIds = groups.flatMap((group) => {
      return (
        group.toolOperations?.map((operation) => {
          return operation.toolUseId;
        }) ?? []
      );
    });

    expect(new Set(toolUseIds).size).toBe(2);
  });
});

describe("groupEventsIntoGroups sequence ordering", () => {
  it("keeps same-sequence events before the next fractional sequence", () => {
    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.textBefore;
      }),
    ).toEqual([
      "First duplicate sequence.",
      "Second duplicate sequence.",
      "Next fractional sequence.",
    ]);
    expect(groups[1]?.sequenceNumber).toBeGreaterThan(5);
    expect(groups[1]?.sequenceNumber).toBeLessThan(5.0005);
  });
});

describe("groupEventsIntoGroups split sequence ordering", () => {
  it("keeps split orphan tool results before the next fractional sequence", () => {
    const nextSequenceNumber = 9.000001;
    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.textBefore ?? group.toolOperations?.[0]?.result?.content;
      }),
    ).toEqual(["first orphan", "second orphan", "Next fractional sequence."]);
    expect(groups[0]?.sequenceNumber).toBeGreaterThan(9);
    expect(groups[1]?.sequenceNumber).toBeGreaterThan(
      groups[0]?.sequenceNumber ?? 9,
    );
    expect(groups[1]?.sequenceNumber).toBeLessThan(nextSequenceNumber);
    expect(groups[2]?.sequenceNumber).toBe(nextSequenceNumber);
  });

  it("keeps split TodoWrite cards before the next fractional sequence", () => {
    const nextSequenceNumber = 7.000001;
    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.type === "todo"
          ? group.todoState?.at(-1)?.content
          : group.textBefore;
      }),
    ).toEqual(["First task", "Second task", "Next fractional sequence."]);
    expect(groups[0]?.sequenceNumber).toBeGreaterThan(7);
    expect(groups[1]?.sequenceNumber).toBeGreaterThan(
      groups[0]?.sequenceNumber ?? 7,
    );
    expect(groups[1]?.sequenceNumber).toBeLessThan(nextSequenceNumber);
    expect(groups[2]?.sequenceNumber).toBe(nextSequenceNumber);
  });
});

describe("groupEventsIntoGroups task event data", () => {
  it("does not treat task_started status as a terminal task status", () => {
    const groups = groupEventsIntoGroups([
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

    const taskGroup = groups[0];
    if (!taskGroup || !isRecord(taskGroup.eventData)) {
      throw new Error("expected task started message");
    }

    expect(taskGroup.eventData.status).toBe("running");
    expect(taskGroup.eventData.task_status).toBeUndefined();
  });

  it("keeps orphan task notification status and summary searchable", () => {
    const groups = groupEventsIntoGroups([
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

    const taskGroup = groups[0];
    if (!taskGroup || !isRecord(taskGroup.eventData)) {
      throw new Error("expected task notification message");
    }

    expect(taskGroup.eventData.task_status).toBe("completed");
    expect(taskGroup.eventData.task_summary).toBe("Orphan task finished");
    expect(eventGroupMatchesSearch(taskGroup, "orphan task")).toBe(true);
    expect(eventGroupMatchesSearch(taskGroup, " orphan task ")).toBe(true);
  });

  it("merges task notifications that already use task status fields", () => {
    const groups = groupEventsIntoGroups([
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

    const taskGroup = groups[0];
    if (!taskGroup || !isRecord(taskGroup.eventData)) {
      throw new Error("expected merged task message");
    }

    expect(groups).toHaveLength(1);
    expect(taskGroup.eventData.task_status).toBe("completed");
    expect(taskGroup.eventData.task_summary).toBe(
      "Task finished through normalized fields",
    );
  });

  it("ignores task progress that arrives after completion", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("system");
  });
});

describe("eventGroupMatchesSearch", () => {
  it("matches text nested in task child groups", () => {
    const groups = groupEventsIntoGroups([
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

    const taskGroup = groups[0];
    if (!taskGroup) {
      throw new Error("expected task message");
    }

    expect(taskGroup.childGroups?.[0]?.textBefore).toBe("Nested child output.");
    expect(eventGroupMatchesSearch(taskGroup, "nested child")).toBe(true);
    expect(eventGroupMatchesSearch(taskGroup, "missing text")).toBe(false);
  });

  it("matches todo item content", () => {
    const groups = groupEventsIntoGroups([
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

    const todoGroup = groups[0];
    if (!todoGroup) {
      throw new Error("expected todo message");
    }

    expect(eventGroupMatchesSearch(todoGroup, "sandbox retry")).toBe(true);
    expect(eventGroupMatchesSearch(todoGroup, "missing text")).toBe(false);
  });
});

describe("groupEventsIntoGroups duplicate tool ids", () => {
  it("matches child tool results by parent task when tool ids repeat", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(2);
    expect(groups[0]?.childGroups).toHaveLength(1);
    expect(groups[1]?.childGroups).toHaveLength(1);
    expect(
      groups[0]?.childGroups?.[0]?.toolOperations?.[0]?.result?.content,
    ).toBe("result task-a");
    expect(
      groups[1]?.childGroups?.[0]?.toolOperations?.[0]?.result?.content,
    ).toBe("result task-b");
  });
});

describe("groupEventsIntoGroups parent tool ids", () => {
  it("does not attach child tool results to a mismatched parent task", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(2);
    expect(
      groups[0]?.childGroups?.[0]?.toolOperations?.[0]?.result,
    ).toBeUndefined();
    expect(groups[1]?.toolOperations?.[0]).toMatchObject({
      toolName: "Unknown",
      result: {
        content: "wrong parent result",
        isError: false,
      },
    });
  });
});

describe("groupEventsIntoGroups thinking content", () => {
  it("keeps Claude Code thinking content blocks visible", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.thinkingBlocks).toEqual([
      "Review the failing logs before responding.",
    ]);
    expect(groups[0]?.textBefore).toBe("The failure is in the log renderer.");
  });

  it("does not drop thinking-only assistant events", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.thinkingBlocks).toEqual([
      "Inspect the previous run output.",
    ]);
    expect(groups[0]?.textBefore).toBeUndefined();
  });
});

describe("groupEventsIntoGroups malformed tool ids", () => {
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

    const firstGroups = groupEventsIntoGroups(events);
    const secondGroups = groupEventsIntoGroups(events);

    expect(
      firstGroups[0]?.toolOperations?.map((operation) => {
        return operation.toolUseId;
      }),
    ).toEqual(["unknown-4-0", "unknown-4-1"]);
    expect(secondGroups[0]?.toolOperations).toEqual(
      firstGroups[0]?.toolOperations,
    );
  });

  it("keeps multiple orphan tool results from one event addressable", () => {
    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.sequenceNumber;
      }),
    ).toEqual([9 + 1 / 1_000_000, 9 + 2 / 1_000_000]);
    expect(
      groups.map((group) => {
        return group.toolOperations?.[0]?.toolUseId;
      }),
    ).toEqual(["orphan-9-0", "orphan-9-1"]);
  });

  it("keeps multiple TodoWrite cards from one event addressable", () => {
    const groups = groupEventsIntoGroups([
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
      groups.map((group) => {
        return group.sequenceNumber;
      }),
    ).toEqual([7 + 1 / 1_000_000, 7 + 2 / 1_000_000]);
    expect(
      new Set(
        groups.map((group) => {
          return eventGroupKey(group);
        }),
      ).size,
    ).toBe(2);
    expect(groups[0]?.todoState).toEqual([
      { content: "First task", status: "in_progress" },
    ]);
    expect(groups[1]?.todoState).toEqual([
      { content: "First task", status: "completed" },
      { content: "Second task", status: "in_progress" },
    ]);
  });
});

describe("groupEventsIntoGroups tool result metadata", () => {
  it("normalizes tool result content that JSON.stringify cannot handle", () => {
    const circularContent: Record<string, unknown> = { output: "done" };
    circularContent.self = circularContent;

    const groups = groupEventsIntoGroups([
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

    expect(groups[0]?.toolOperations?.[0]?.result?.content).toBe(
      '{"output":"done","self":"[Circular]"}',
    );
    expect(groups[0]?.toolOperations?.[1]?.result?.content).toBe("42");
  });

  it("bounds deeply nested and sparse tool result content", () => {
    let deepContent: Record<string, unknown> = { leaf: "done" };
    for (let i = 0; i < 80; i += 1) {
      deepContent = { next: deepContent };
    }
    const sparseContent: unknown[] = [];
    sparseContent.length = 10_000;

    const groups = groupEventsIntoGroups([
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

    expect(groups[0]?.toolOperations?.[0]?.result?.content).toContain(
      '"[MaxDepth]"',
    );
    expect(groups[0]?.toolOperations?.[1]?.result?.content).toContain(
      '"... 9900 more items"',
    );
  });
});

describe("groupEventsIntoGroups tool result metadata validation", () => {
  it("ignores negative tool result duration and bytes", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups[0]?.toolOperations?.[0]?.result).toMatchObject({
      content: "done",
      isError: false,
    });
    expect(groups[0]?.toolOperations?.[0]?.result?.durationMs).toBeUndefined();
    expect(groups[0]?.toolOperations?.[0]?.result?.bytes).toBeUndefined();
  });
});

describe("groupEventsIntoGroups malformed TodoWrite values", () => {
  it("uses a safe fallback for malformed todo values", () => {
    const malformedTodo = Object.create(null) as Record<string, unknown>;
    malformedTodo.toJSON = () => {
      throw new Error("cannot serialize todo");
    };

    const groups = groupEventsIntoGroups([
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

    expect(groups[0]?.todoState).toEqual([
      { content: "{}", status: "pending" },
    ]);
  });
});

describe("groupEventsIntoGroups TodoWrite snapshots", () => {
  it("renders malformed TodoWrite calls as ordinary tools", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(1);
    expect(groups[0]?.type).toBe("assistant");
    expect(groups[0]?.todoState).toBeUndefined();
    expect(groups[0]?.toolOperations?.[0]).toMatchObject({
      toolName: "TodoWrite",
      result: {
        content: "invalid todo payload",
        isError: true,
      },
    });
  });

  it("keeps TodoWrite errors attached to todo cards", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups).toHaveLength(1);
    const [group] = groups;
    if (!group) {
      throw new Error("expected todo message");
    }

    expect(group.type).toBe("todo");
    expect(group.todoState).toEqual([
      { content: "Check failure", status: "pending" },
    ]);
    expect(group.toolOperations?.[0]).toMatchObject({
      toolName: "TodoWrite",
      result: {
        content: "todo write failed",
        isError: true,
      },
    });
    expect(eventGroupMatchesSearch(group, "todo write failed")).toBe(true);
    expect(eventGroupMatchesSearch(group, "TodoWrite")).toBe(false);
  });
});

describe("groupEventsIntoGroups TodoWrite state", () => {
  it("treats TodoWrite input as the latest ordered todo snapshot", () => {
    const groups = groupEventsIntoGroups([
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

    expect(groups[0]?.todoState).toEqual([
      { content: "Duplicate task", status: "pending" },
      { content: "Duplicate task", status: "in_progress" },
      { content: "Removed task", status: "pending" },
    ]);
    expect(groups[1]?.todoState).toEqual([
      { content: "Duplicate task", status: "completed" },
      { content: "Duplicate task", status: "in_progress" },
    ]);
  });
});
