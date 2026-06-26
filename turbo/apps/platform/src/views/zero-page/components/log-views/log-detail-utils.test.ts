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
