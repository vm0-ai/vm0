import { describe, expect, it } from "vitest";
import { CHAT_EVENT_TYPES, type ChatEventType } from "../chat-events";
import { chatEventFromRow } from "../chat-event-row-projection";
import { chatEventRowV4Schema, type ChatEventRowV4 } from "../chat-event-rows";

const CREATED_AT = "2026-08-08T10:00:00.000Z";

function v4Row(overrides: Partial<ChatEventRowV4>): ChatEventRowV4 {
  return {
    id: "00000000-0000-4000-8000-000000000003",
    chatThreadId: "00000000-0000-4000-8000-000000000002",
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 2,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function projectableV4Row(eventType: ChatEventType): ChatEventRowV4 {
  const runId = "00000000-0000-4000-8000-000000000013";
  const revokesEventId = "00000000-0000-4000-8000-000000000014";
  const userMessage = {
    version: 1,
    parts: [{ type: "text", text: eventType }],
  };
  const variants: Record<ChatEventType, Partial<ChatEventRowV4>> = {
    "input.prompt": { payload: { userMessage }, contextType: "web" },
    "input.automation": {
      payload: { userMessage },
      contextType: "automation",
      contextId: "00000000-0000-4000-8000-000000000015",
    },
    "input.goal": {
      payload: { userMessage },
      contextType: "goal",
      contextId: "00000000-0000-4000-8000-000000000016",
    },
    "input.budget": { payload: { userMessage }, contextType: "web" },
    "input.rejected": {
      payload: { userMessage, error: "rejected" },
      contextType: "web",
    },
    "output.message": { payload: { content: "message" } },
    "output.error": {
      payload: { content: "display error", error: "output error" },
    },
    "output.thinking": { payload: { thinking: "thinking" } },
    "output.followups": { payload: { content: "followups" } },
    "run.queued": { runId, payload: { content: "queued" } },
    "run.dequeued": { runId, revokesEventId },
    "run.completed": { runId },
    "run.failed": {
      runId,
      payload: { content: "failed", error: "runner error" },
    },
    "run.cancelled": { runId, payload: { error: "cancelled" } },
    "control.interrupt": { runId },
    "control.revoke": { revokesEventId },
    "browser.open": {},
    "browser.close": {},
    "goal.open": { payload: { content: "goal opened" } },
    "goal.close": {},
    "usage.recorded": {
      runId,
      payload: {
        usage: {
          version: 1,
          totalCredits: 1,
          settledAt: CREATED_AT,
          breakdown: [],
        },
      },
    },
  };
  return v4Row({ eventType, ...variants[eventType] });
}

describe("canonical chat event row schema", () => {
  it("accepts strict v4 rows and rejects legacy top-level fields", () => {
    const v4 = v4Row({ payload: { content: "canonical" } });
    expect(
      chatEventRowV4Schema.parse(JSON.parse(JSON.stringify(v4))),
    ).toStrictEqual(v4);
    expect(
      chatEventRowV4Schema.safeParse({ ...v4, content: "legacy" }).success,
    ).toBe(false);
  });

  it("preserves canonical multi-leaf payloads and nested JSON nulls", () => {
    const row = v4Row({
      payload: {
        content: "historical content",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "historical input" }],
          nestedProbe: { value: null },
        },
        thinking: "historical thinking",
        error: "historical error",
        usage: {
          version: 1,
          totalCredits: 4,
          settledAt: CREATED_AT,
          breakdown: [],
        },
      },
    });
    const parsed = chatEventRowV4Schema.parse(JSON.parse(JSON.stringify(row)));
    expect(parsed).toStrictEqual(row);
    expect(parsed.payload).toHaveProperty(
      "userMessage.nestedProbe.value",
      null,
    );
    expect(parsed).not.toHaveProperty("content");
    expect(parsed).not.toHaveProperty("interruptsRunId");
    expect(parsed).not.toHaveProperty("runGroupId");
  });
});

describe("canonical row projection preserves the public ChatEvent contract", () => {
  it("serializes and projects every event type from canonical fields", () => {
    expect(
      CHAT_EVENT_TYPES.map((eventType) => {
        const wireRow = JSON.parse(
          JSON.stringify(projectableV4Row(eventType)),
        ) as unknown;
        return chatEventFromRow(chatEventRowV4Schema.parse(wireRow)).eventType;
      }),
    ).toStrictEqual([...CHAT_EVENT_TYPES]);
  });

  it("emits the canonical interrupt run as interruptsRunId, never runId", () => {
    const target = "00000000-0000-4000-8000-000000000010";
    const projected = chatEventFromRow(
      v4Row({ eventType: "control.interrupt", runId: target }),
    );
    expect(projected).toMatchObject({
      eventType: "control.interrupt",
      interruptsRunId: target,
    });
    expect(projected.runId).toBeUndefined();
  });

  it("emits goal context pointers as runGroupId", () => {
    const goalId = "00000000-0000-4000-8000-000000000011";
    const projected = chatEventFromRow(
      v4Row({
        payload: { content: "goal result" },
        contextType: "goal",
        contextId: goalId,
      }),
    );
    expect(projected).toMatchObject({
      eventType: "output.message",
      content: "goal result",
      runGroupId: goalId,
    });
  });

  it("reads canonical usage and error payloads", () => {
    const usage = {
      version: 1,
      totalCredits: 1,
      settledAt: CREATED_AT,
      breakdown: [],
    };
    const runId = "00000000-0000-4000-8000-000000000013";
    const projected = chatEventFromRow(
      v4Row({
        eventType: "usage.recorded",
        runId,
        payload: { usage },
      }),
    );
    expect(projected).toMatchObject({
      eventType: "usage.recorded",
      runId,
      usage,
    });

    const failed = chatEventFromRow(
      v4Row({
        eventType: "run.failed",
        runId,
        payload: { content: "run failed", error: "runner error" },
      }),
    );
    expect(failed).toMatchObject({
      eventType: "run.failed",
      runId,
      content: "run failed",
      error: "runner error",
      runLifecycleEvent: "failed",
    });
  });
});
