import { describe, expect, it } from "vitest";
import { chatEventFromRow } from "../chat-event-row-projection";
import {
  canonicalChatEventRow,
  chatEventRowReadSchema,
  type ChatEventRow,
  type ChatEventRowV4,
} from "../chat-event-rows";

const CREATED_AT = "2026-08-08T10:00:00.000Z";

function v3Row(overrides: Partial<ChatEventRow>): ChatEventRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    chatThreadId: "00000000-0000-4000-8000-000000000002",
    runId: null,
    usagePayload: null,
    revokesEventId: null,
    interruptsRunId: null,
    runGroupId: null,
    eventType: "output.message",
    contextType: null,
    contextId: null,
    content: null,
    userMessage: null,
    thinking: null,
    error: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 1,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

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

describe("chat event row reader union", () => {
  it("discriminates strict v3 and v4 rows and rejects hybrids", () => {
    const v3 = v3Row({ content: "legacy" });
    const v4 = v4Row({ payload: { content: "canonical" } });
    expect(
      chatEventRowReadSchema.parse(JSON.parse(JSON.stringify(v3))),
    ).toStrictEqual(v3);
    expect(
      chatEventRowReadSchema.parse(JSON.parse(JSON.stringify(v4))),
    ).toStrictEqual(v4);
    expect(
      chatEventRowReadSchema.safeParse({ ...v3, payload: null }).success,
    ).toBe(false);
    expect(
      chatEventRowReadSchema.safeParse({ ...v4, content: "legacy" }).success,
    ).toBe(false);
  });

  it("folds every non-null legacy leaf into the canonical payload", () => {
    const usage = {
      version: 1,
      totalCredits: 2.5,
      settledAt: CREATED_AT,
      breakdown: [],
    };
    const userMessage = {
      version: 1,
      parts: [{ type: "text", text: "probe" }],
      compatibilityProbe: { nested: null },
    };
    const normalized = canonicalChatEventRow(
      v3Row({
        content: "all leaves",
        userMessage,
        thinking: "thinking leaf",
        error: "error leaf",
        usagePayload: usage,
      }),
    );
    expect(normalized.payload).toStrictEqual({
      content: "all leaves",
      userMessage,
      thinking: "thinking leaf",
      error: "error leaf",
      usage,
    });
    // Nested JSON nulls survive normalization verbatim.
    expect(normalized.payload).toHaveProperty(
      "userMessage.compatibilityProbe.nested",
      null,
    );
    expect(canonicalChatEventRow(v3Row({})).payload).toBeNull();
  });

  it("adopts interrupts_run_id as the canonical run of a v3 interrupt", () => {
    const target = "00000000-0000-4000-8000-000000000010";
    const masked = canonicalChatEventRow(
      v3Row({
        eventType: "control.interrupt",
        runId: null,
        interruptsRunId: target,
      }),
    );
    expect(masked.runId).toBe(target);
    const owned = canonicalChatEventRow(
      v3Row({ eventType: "output.message", runId: target }),
    );
    expect(owned.runId).toBe(target);
  });

  it("completes compatible goal context pointers from runGroupId", () => {
    const goalId = "00000000-0000-4000-8000-000000000011";
    const grouped = canonicalChatEventRow(v3Row({ runGroupId: goalId }));
    expect(grouped.contextType).toBe("goal");
    expect(grouped.contextId).toBe(goalId);

    const goalInput = canonicalChatEventRow(
      v3Row({
        eventType: "input.goal",
        runGroupId: goalId,
        contextType: "goal",
        contextId: null,
        userMessage: { version: 1, parts: [] },
      }),
    );
    expect(goalInput.contextType).toBe("goal");
    expect(goalInput.contextId).toBe(goalId);

    const foreignContext = canonicalChatEventRow(
      v3Row({
        contextType: "teams",
        contextId: "00000000-0000-4000-8000-000000000012",
      }),
    );
    expect(foreignContext.contextType).toBe("teams");
    expect(foreignContext.contextId).toBe(
      "00000000-0000-4000-8000-000000000012",
    );
  });

  it("passes canonical rows through unchanged", () => {
    const canonical = v4Row({
      eventType: "control.interrupt",
      runId: "00000000-0000-4000-8000-000000000010",
    });
    expect(canonicalChatEventRow(canonical)).toBe(canonical);
  });
});

describe("canonical row projection keeps the v3 ChatEvent shape", () => {
  it("emits the canonical interrupt run as interruptsRunId, never runId", () => {
    const target = "00000000-0000-4000-8000-000000000010";
    const projected = chatEventFromRow(
      canonicalChatEventRow(
        v3Row({
          eventType: "control.interrupt",
          runId: null,
          interruptsRunId: target,
        }),
      ),
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

  it("reads every payload leaf the way the legacy columns projected", () => {
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
