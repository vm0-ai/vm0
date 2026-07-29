import { describe, expect, it } from "vitest";

import {
  CHAT_EVENT_TYPES,
  foldActiveChatGoalObjective,
  foldChatAutomationIntakePause,
  foldChatRunStates,
  foldLatestChatUsageByRunId,
  foldPendingChatQueueEvents,
  foldRunnableChatQueueEvents,
  isPendingChatQueueEvent,
  isValidChatEventRevocation,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "../chat-events";
import {
  chatEventResponse,
  chatEventResponseSchema,
  chatEventSchema,
  chatEventsContract,
  chatThreadEventsContract,
  type ChatEvent,
} from "../chat-threads";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-23T00:00:00.000Z";

const chatEvents = [
  {
    id: "input-prompt",
    seqId: 1,
    threadId: THREAD_ID,
    eventType: "input.prompt",
    content: "Run the task",
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Run the task" }],
    },
    createdAt: CREATED_AT,
  },
  {
    id: "input-automation",
    seqId: 2,
    threadId: THREAD_ID,
    eventType: "input.automation",
    content: null,
    automationId: "00000000-0000-4000-8000-000000000010",
    triggerSource: "workflow-event",
    triggerBrief: "Gmail label applied",
    createdAt: "2026-07-23T00:00:01.000Z",
  },
  {
    id: "input-rejected",
    seqId: 3,
    threadId: THREAD_ID,
    eventType: "input.rejected",
    content: "Run the task",
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "Run the task" }],
    },
    error: "Insufficient credits",
    automationId: "00000000-0000-4000-8000-000000000010",
    triggerSource: "workflow-event",
    triggerBrief: "Gmail label applied",
    createdAt: CREATED_AT,
  },
  {
    id: "output-message",
    seqId: 4,
    threadId: THREAD_ID,
    eventType: "output.message",
    content: "Done",
    createdAt: CREATED_AT,
  },
  {
    id: "output-error",
    seqId: 5,
    threadId: THREAD_ID,
    eventType: "output.error",
    content: null,
    error: "Run failed",
    createdAt: CREATED_AT,
  },
  {
    id: "output-thinking",
    seqId: 6,
    threadId: THREAD_ID,
    eventType: "output.thinking",
    content: null,
    thinking: "Working",
    createdAt: CREATED_AT,
  },
  {
    id: "output-followups",
    seqId: 7,
    threadId: THREAD_ID,
    eventType: "output.followups",
    content: null,
    recommendedFollowups: [{ prompt: "Continue", kind: "talk" }],
    createdAt: CREATED_AT,
  },
  {
    id: "run-queued",
    seqId: 8,
    threadId: THREAD_ID,
    eventType: "run.queued",
    runId: "run-1",
    content: "Waiting in queue",
    createdAt: CREATED_AT,
  },
  {
    id: "run-dequeued",
    seqId: 9,
    threadId: THREAD_ID,
    eventType: "run.dequeued",
    runId: "run-1",
    content: null,
    revokesEventId: "run-queued",
    createdAt: CREATED_AT,
  },
  {
    id: "run-completed",
    seqId: 10,
    threadId: THREAD_ID,
    eventType: "run.completed",
    runId: "run-1",
    content: null,
    runLifecycleEvent: "completed",
    createdAt: CREATED_AT,
  },
  {
    id: "run-failed",
    seqId: 11,
    threadId: THREAD_ID,
    eventType: "run.failed",
    runId: "run-2",
    content: null,
    runLifecycleEvent: "failed",
    createdAt: CREATED_AT,
  },
  {
    id: "run-cancelled",
    seqId: 12,
    threadId: THREAD_ID,
    eventType: "run.cancelled",
    runId: "run-3",
    content: null,
    runLifecycleEvent: "cancelled",
    createdAt: CREATED_AT,
  },
  {
    id: "queue-automation-paused",
    seqId: 13,
    threadId: THREAD_ID,
    eventType: "queue.automation_paused",
    content: null,
    pauseReason: "Model provider unavailable",
    createdAt: "2026-07-23T00:01:00.000Z",
  },
  {
    id: "queue-automation-resumed",
    seqId: 14,
    threadId: THREAD_ID,
    eventType: "queue.automation_resumed",
    content: null,
    createdAt: "2026-07-23T00:02:00.000Z",
  },
  {
    id: "control-interrupt",
    seqId: 15,
    threadId: THREAD_ID,
    eventType: "control.interrupt",
    content: null,
    interruptsRunId: "run-3",
    createdAt: CREATED_AT,
  },
  {
    id: "control-revoke",
    seqId: 16,
    threadId: THREAD_ID,
    eventType: "control.revoke",
    content: null,
    revokesEventId: "input-prompt",
    createdAt: CREATED_AT,
  },
  {
    id: "goal-changed",
    seqId: 17,
    threadId: THREAD_ID,
    eventType: "goal.changed",
    content: null,
    goalEvent: {
      type: "state",
      status: "active",
      objectiveBrief: "Ship the refactor",
    },
    createdAt: CREATED_AT,
  },
  {
    id: "usage-recorded",
    seqId: 18,
    threadId: THREAD_ID,
    eventType: "usage.recorded",
    runId: "run-1",
    content: null,
    usage: {
      version: 1,
      totalCredits: 4,
      settledAt: CREATED_AT,
      breakdown: [],
    },
    createdAt: CREATED_AT,
  },
] satisfies ChatEvent[];

const queueFoldFixture = [
  {
    id: "automation-oldest",
    eventType: "input.automation",
    createdAt: "2026-07-23T00:00:00.000Z",
  },
  {
    id: "prompt-newer",
    eventType: "input.prompt",
    createdAt: "2026-07-23T00:01:00.000Z",
  },
  {
    id: "prompt-claimed",
    eventType: "input.prompt",
    runId: "run-claimed",
    createdAt: "2026-07-23T00:00:30.000Z",
  },
  {
    id: "automation-revoked",
    eventType: "input.automation",
    createdAt: "2026-07-23T00:00:15.000Z",
  },
  {
    id: "automation-revoker",
    eventType: "control.revoke",
    revokesEventId: "automation-revoked",
    createdAt: "2026-07-23T00:02:00.000Z",
  },
  {
    id: "automation-paused",
    eventType: "queue.automation_paused",
    pauseReason: "Provider unavailable",
    createdAt: "2026-07-23T00:03:00.000Z",
  },
] as const;

describe("ChatEvent catalog", () => {
  it("parses exactly one canonical fixture for every registered leaf", () => {
    expect(
      chatEvents.map((event) => {
        return event.eventType;
      }),
    ).toStrictEqual([...CHAT_EVENT_TYPES]);
    for (const event of chatEvents) {
      expect(chatEventSchema.parse(event)).toStrictEqual(event);
    }
  });

  it("fails closed for unknown leaves and server-only fields", () => {
    const prompt = chatEvents[0];
    expect(
      chatEventSchema.safeParse({ ...prompt, eventType: "input.unknown" })
        .success,
    ).toBe(false);
    expect(
      chatEventSchema.safeParse({
        ...prompt,
        encryptedParams: "must-stay-server-side",
      }).success,
    ).toBe(false);
    const automation = chatEvents[1];
    expect(
      chatEventSchema.safeParse({
        ...automation,
        encryptedParams: "must-stay-server-side",
      }).success,
    ).toBe(false);
  });

  it("emits canonical responses for every registered leaf", () => {
    for (const event of chatEvents) {
      const response = chatEventResponse(event);
      expect(response).toStrictEqual(event);
      expect(chatEventResponseSchema.parse(response)).toStrictEqual(response);
    }
  });

  it("rejects a response that only carries the retired rich-input field", () => {
    const userMessage = {
      version: 1 as const,
      parts: [{ type: "text" as const, text: "Run the task" }],
    };
    expect(
      chatEventResponseSchema.safeParse({
        ...chatEventResponse(chatEvents[0]!),
        userMessage: undefined,
        structuredPrompt: userMessage,
      }).success,
    ).toBe(false);
  });
});

describe("ChatEvent revocation rules", () => {
  const validPairs = new Set([
    "input.prompt->input.prompt",
    "input.prompt->input.automation",
    "input.prompt->output.followups",
    "input.rejected->input.prompt",
    "input.rejected->input.automation",
    "input.rejected->output.followups",
    "control.revoke->input.prompt",
    "control.revoke->input.automation",
    "control.revoke->input.rejected",
    "run.dequeued->run.queued",
  ]);

  it("accepts only the registered source and target leaf pairs", () => {
    for (const sourceType of CHAT_EVENT_TYPES) {
      for (const targetType of CHAT_EVENT_TYPES) {
        expect(isValidChatEventRevocation(sourceType, targetType)).toBe(
          validPairs.has(`${sourceType}->${targetType}`),
        );
      }
    }
  });
});

describe("ChatEvent folds", () => {
  it("lets a terminal event end queued state without a revoke edge", () => {
    const queued = chatEvents.find((event) => {
      return event.eventType === "run.queued";
    });
    const completed = chatEvents.find((event) => {
      return event.eventType === "run.completed";
    });
    if (!queued || !completed) {
      throw new Error("Missing run fold fixtures");
    }

    expect(foldChatRunStates([queued, completed]).get("run-1")).toBe(
      "completed",
    );
    expect(terminatedChatRunIds([queued, completed])).toStrictEqual(
      new Set(["run-1"]),
    );
  });

  it("folds goal state chronologically with last-write-wins semantics", () => {
    const active = chatEvents.find((event) => {
      return event.eventType === "goal.changed";
    });
    if (!active) {
      throw new Error("Missing goal fold fixture");
    }
    const paused = {
      ...active,
      id: "goal-paused",
      goalEvent: { type: "state", status: "paused" } as const,
    };

    expect(foldActiveChatGoalObjective([active])).toBe("Ship the refactor");
    expect(foldActiveChatGoalObjective([active, paused])).toBeNull();
  });

  it("keeps the latest settled usage snapshot for each run", () => {
    const usage = chatEvents.find((event) => {
      return event.eventType === "usage.recorded";
    });
    if (!usage) {
      throw new Error("Missing usage fold fixture");
    }
    const latest = {
      ...usage,
      id: "usage-latest",
      usage: {
        ...usage.usage,
        totalCredits: 8,
        settledAt: "2026-07-23T00:02:00.000Z",
      },
    };
    const stale = {
      ...usage,
      id: "usage-stale",
      usage: {
        ...usage.usage,
        totalCredits: 6,
        settledAt: "2026-07-23T00:01:00.000Z",
      },
    };

    expect(
      foldLatestChatUsageByRunId([usage, latest, stale]).get("run-1")
        ?.totalCredits,
    ).toBe(8);
  });

  it("collects immutable revoke relationships without hiding source facts", () => {
    expect(revokedChatEventIds(chatEvents)).toStrictEqual(
      new Set(["run-queued", "input-prompt"]),
    );
  });

  it("folds pending queue events by user priority, original time, and revoke state", () => {
    const revoked = revokedChatEventIds(queueFoldFixture);
    expect(isPendingChatQueueEvent(queueFoldFixture[1], revoked)).toBe(true);
    expect(isPendingChatQueueEvent(queueFoldFixture[3], revoked)).toBe(false);
    expect(
      foldPendingChatQueueEvents(queueFoldFixture).map((event) => {
        return event.id;
      }),
    ).toStrictEqual(["prompt-newer", "automation-oldest"]);
  });

  it("folds automation intake pause without blocking pending user messages", () => {
    expect(foldChatAutomationIntakePause(queueFoldFixture)).toStrictEqual({
      pausedAt: "2026-07-23T00:03:00.000Z",
      pauseReason: "Provider unavailable",
    });
    expect(
      foldRunnableChatQueueEvents(queueFoldFixture).map((event) => {
        return event.id;
      }),
    ).toStrictEqual(["prompt-newer"]);

    const resumed = [
      ...queueFoldFixture,
      {
        id: "automation-resumed",
        eventType: "queue.automation_resumed" as const,
        createdAt: "2026-07-23T00:04:00.000Z",
      },
    ];
    expect(foldChatAutomationIntakePause(resumed)).toBeNull();
    expect(
      foldRunnableChatQueueEvents(resumed).map((event) => {
        return event.id;
      }),
    ).toStrictEqual(["prompt-newer", "automation-oldest"]);
  });
});

describe("ChatEvent HTTP contracts", () => {
  it("uses event naming for canonical send and read routes", () => {
    expect(chatEventsContract.send.path).toBe("/api/zero/chat/events");
    expect(chatThreadEventsContract.list.path).toBe(
      "/api/zero/chat-threads/:threadId/events",
    );
    expect(chatThreadEventsContract.get.path).toBe(
      "/api/zero/chat-threads/:threadId/events/:eventId",
    );
  });

  it("uses event ids in canonical write bodies", () => {
    const parsed = chatEventsContract.send.body.parse({
      agentId: "agent-1",
      threadId: THREAD_ID,
      revokesEventId: "input-prompt",
      clientEventId: "00000000-0000-4000-8000-000000000002",
    });

    expect(parsed).toMatchObject({
      revokesEventId: "input-prompt",
      clientEventId: "00000000-0000-4000-8000-000000000002",
    });
  });
});
