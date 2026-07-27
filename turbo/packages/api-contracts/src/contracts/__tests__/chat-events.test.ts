import { describe, expect, it } from "vitest";

import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  foldActiveChatGoalObjective,
  foldChatRunStates,
  foldLatestChatUsageByRunId,
  isValidChatEventRevocation,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "../chat-events";
import {
  canonicalChatEvent,
  canonicalChatEventFromCompatibilityResponse,
  chatEventResponse,
  chatEventResponseSchema,
  chatEventSchema,
  chatEventsContract,
  chatMessagesContract,
  legacyChatMessageSendBody,
  legacyPagedChatMessageSchema,
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
    createdAt: CREATED_AT,
  },
  {
    id: "input-rejected",
    seqId: 2,
    threadId: THREAD_ID,
    eventType: "input.rejected",
    content: "Run the task",
    error: "Insufficient credits",
    createdAt: CREATED_AT,
  },
  {
    id: "output-message",
    seqId: 3,
    threadId: THREAD_ID,
    eventType: "output.message",
    content: "Done",
    createdAt: CREATED_AT,
  },
  {
    id: "output-error",
    seqId: 4,
    threadId: THREAD_ID,
    eventType: "output.error",
    content: null,
    error: "Run failed",
    createdAt: CREATED_AT,
  },
  {
    id: "output-thinking",
    seqId: 5,
    threadId: THREAD_ID,
    eventType: "output.thinking",
    content: null,
    thinking: "Working",
    createdAt: CREATED_AT,
  },
  {
    id: "output-followups",
    seqId: 6,
    threadId: THREAD_ID,
    eventType: "output.followups",
    content: null,
    recommendedFollowups: [{ prompt: "Continue", kind: "talk" }],
    createdAt: CREATED_AT,
  },
  {
    id: "run-queued",
    seqId: 7,
    threadId: THREAD_ID,
    eventType: "run.queued",
    runId: "run-1",
    content: "Waiting in queue",
    createdAt: CREATED_AT,
  },
  {
    id: "run-dequeued",
    seqId: 8,
    threadId: THREAD_ID,
    eventType: "run.dequeued",
    runId: "run-1",
    content: null,
    revokesEventId: "run-queued",
    createdAt: CREATED_AT,
  },
  {
    id: "run-completed",
    seqId: 9,
    threadId: THREAD_ID,
    eventType: "run.completed",
    runId: "run-1",
    content: null,
    runLifecycleEvent: "completed",
    createdAt: CREATED_AT,
  },
  {
    id: "run-failed",
    seqId: 10,
    threadId: THREAD_ID,
    eventType: "run.failed",
    runId: "run-2",
    content: null,
    runLifecycleEvent: "failed",
    createdAt: CREATED_AT,
  },
  {
    id: "run-cancelled",
    seqId: 11,
    threadId: THREAD_ID,
    eventType: "run.cancelled",
    runId: "run-3",
    content: null,
    runLifecycleEvent: "cancelled",
    createdAt: CREATED_AT,
  },
  {
    id: "control-interrupt",
    seqId: 12,
    threadId: THREAD_ID,
    eventType: "control.interrupt",
    content: null,
    interruptsRunId: "run-3",
    createdAt: CREATED_AT,
  },
  {
    id: "control-revoke",
    seqId: 13,
    threadId: THREAD_ID,
    eventType: "control.revoke",
    content: null,
    revokesEventId: "input-prompt",
    createdAt: CREATED_AT,
  },
  {
    id: "goal-changed",
    seqId: 14,
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
    seqId: 15,
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

  it("fails closed for unknown leaves and compatibility-only fields", () => {
    const prompt = chatEvents[0];
    expect(
      chatEventSchema.safeParse({ ...prompt, eventType: "input.unknown" })
        .success,
    ).toBe(false);
    expect(chatEventSchema.safeParse({ ...prompt, role: "user" }).success).toBe(
      false,
    );
    expect(
      chatEventSchema.safeParse({
        ...prompt,
        revokesMessageId: "legacy-target",
      }).success,
    ).toBe(false);
  });

  it("round-trips the one-release wire compatibility projection", () => {
    for (const event of chatEvents) {
      const response = chatEventResponse(event);
      expect(response.role).toBe(chatEventCompatibilityRole(event.eventType));
      expect(chatEventResponseSchema.parse(response)).toStrictEqual(response);
      expect(canonicalChatEvent(response)).toStrictEqual(event);
    }
  });

  it("rejects a compatibility role that disagrees with eventType", () => {
    expect(
      chatEventResponseSchema.safeParse({
        ...chatEventResponse(chatEvents[0]!),
        role: "assistant",
      }).success,
    ).toBe(false);
  });

  it("upgrades every preceding message response leaf into a ChatEvent", () => {
    for (const event of chatEvents) {
      const response = chatEventResponse(event);
      const {
        eventType,
        threadId,
        revokesEventId,
        ...legacyCompatibilityResponse
      } = response;
      void eventType;
      void threadId;
      void revokesEventId;
      const legacy = legacyPagedChatMessageSchema.parse(
        event.eventType === "run.queued"
          ? { ...legacyCompatibilityResponse, runEventId: "queue:queued" }
          : event.eventType === "run.dequeued"
            ? { ...legacyCompatibilityResponse, runEventId: "queue:dequeued" }
            : legacyCompatibilityResponse,
      );
      expect(
        canonicalChatEventFromCompatibilityResponse(THREAD_ID, legacy),
      ).toStrictEqual(
        event.eventType === "run.queued"
          ? { ...event, runEventId: "queue:queued" }
          : event.eventType === "run.dequeued"
            ? { ...event, runEventId: "queue:dequeued" }
            : event,
      );
    }
  });
});

describe("ChatEvent revocation rules", () => {
  const validPairs = new Set([
    "input.prompt->input.prompt",
    "input.prompt->output.followups",
    "input.rejected->input.prompt",
    "input.rejected->output.followups",
    "control.revoke->input.prompt",
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

  it("maps canonical write ids to the preceding message route", () => {
    const legacy = legacyChatMessageSendBody(
      chatEventsContract.send.body.parse({
        agentId: "agent-1",
        threadId: THREAD_ID,
        revokesEventId: "input-prompt",
        clientEventId: "00000000-0000-4000-8000-000000000002",
      }),
    );

    expect(chatMessagesContract.send.body.parse(legacy)).toMatchObject({
      revokesMessageId: "input-prompt",
      clientMessageId: "00000000-0000-4000-8000-000000000002",
    });
    expect(legacy).not.toHaveProperty("revokesEventId");
    expect(legacy).not.toHaveProperty("clientEventId");
  });
});
