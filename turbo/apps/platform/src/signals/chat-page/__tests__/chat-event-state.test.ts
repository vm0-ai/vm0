import { describe, expect, it } from "vitest";

import type { ChatEvent } from "../chat-event-types.ts";
import {
  groupSemanticChatEvents,
  semanticChatEventsFromChatEvents,
} from "../chat-event-state.ts";

const THREAD_ID = "thread-chat-steer-projection";
const RUN_ID = "run-chat-steer-projection";

function promptEvent(
  id: string,
  overrides: Partial<Extract<ChatEvent, { eventType: "input.prompt" }>> = {},
): Extract<ChatEvent, { eventType: "input.prompt" }> {
  return {
    id,
    threadId: THREAD_ID,
    eventType: "input.prompt",
    content: null,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: id }],
    },
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function assistantEvent(
  id: string,
): Extract<ChatEvent, { eventType: "output.message" }> {
  return {
    id,
    threadId: THREAD_ID,
    eventType: "output.message",
    content: id,
    runId: RUN_ID,
    createdAt: "2026-08-04T00:00:01.000Z",
  };
}

describe("chat steer event projection", () => {
  it("moves pending prompts out of queue only while chat steer is enabled", () => {
    const prompt = promptEvent("pending-prompt");

    expect(
      semanticChatEventsFromChatEvents([prompt], false)[0]?.isQueued,
    ).toBeTruthy();
    expect(
      semanticChatEventsFromChatEvents([prompt], true)[0]?.isQueued,
    ).toBeFalsy();
  });

  it("keeps the temporary morning brief exception in queue", () => {
    const morningBrief = promptEvent("morning-brief", {
      triggerSource: "workflow-schedule",
    });

    expect(
      semanticChatEventsFromChatEvents([morningBrief], true)[0]?.isQueued,
    ).toBeTruthy();
  });

  it("preserves alternating user and assistant groups within one run", () => {
    const events: ChatEvent[] = [
      promptEvent("first-user", { runId: RUN_ID }),
      assistantEvent("first-assistant"),
      promptEvent("first-steered-user", { runId: RUN_ID }),
      promptEvent("second-steered-user", { runId: RUN_ID }),
      assistantEvent("second-assistant"),
    ];

    const groups = groupSemanticChatEvents(
      semanticChatEventsFromChatEvents(events, true),
    );

    expect(
      groups.activeGroups.map((group) => {
        return group.role;
      }),
    ).toStrictEqual(["user", "assistant", "user", "assistant"]);
    expect(
      groups.activeGroups.map((group) => {
        return group.events.map((entry) => {
          return entry.event.id;
        });
      }),
    ).toStrictEqual([
      ["first-user"],
      ["first-assistant"],
      ["first-steered-user", "second-steered-user"],
      ["second-assistant"],
    ]);
  });
});
