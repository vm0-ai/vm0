import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../../../signals/zero-page/log-types.ts";
import { groupEventsIntoMessages } from "./log-detail-utils.ts";

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
});
