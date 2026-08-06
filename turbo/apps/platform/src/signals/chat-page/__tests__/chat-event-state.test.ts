import { describe, expect, it } from "vitest";

import type { ChatEvent } from "../chat-event-types.ts";
import {
  groupSemanticChatEvents,
  semanticChatEventsFromChatEvents,
} from "../chat-event-state.ts";

describe("chat event visibility", () => {
  it("omits budget inputs only from visible message groups", () => {
    const events = [
      {
        id: "prompt",
        threadId: "thread-1",
        eventType: "input.prompt",
        content: null,
        runId: "run-1",
        seqId: 1,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Start the task" }],
        },
        createdAt: "2026-08-06T00:00:00.000Z",
      },
      {
        id: "budget",
        threadId: "thread-1",
        eventType: "input.budget",
        content: null,
        runId: "run-1",
        seqId: 2,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Five minutes remain" }],
        },
        createdAt: "2026-08-06T00:01:00.000Z",
      },
      {
        id: "message",
        threadId: "thread-1",
        eventType: "output.message",
        content: "Done",
        runId: "run-1",
        seqId: 3,
        createdAt: "2026-08-06T00:02:00.000Z",
      },
    ] satisfies ChatEvent[];

    const semanticEvents = semanticChatEventsFromChatEvents(events);
    const groups = groupSemanticChatEvents(semanticEvents);

    expect(
      events.map((event) => {
        return event.id;
      }),
    ).toContain("budget");
    expect(
      groups.allGroups.flatMap((group) => {
        return group.events.map((entry) => {
          return entry.event.id;
        });
      }),
    ).toStrictEqual(["prompt", "message"]);
  });
});
