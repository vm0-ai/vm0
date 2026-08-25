import {
  chatEventSchema,
  type ChatEvent,
  type ChatToolEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import type { OutputToolPayload } from "@okouai/api-contracts/contracts/chat-events";
import { describe, expect, it } from "vitest";

import {
  projectToolActivitySnapshots,
  semanticChatEventsFromChatEvents,
} from "../chat-event-state.ts";

type ProjectedChatEvent = ReturnType<
  typeof semanticChatEventsFromChatEvents
>[number]["event"];

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const RUN_ID = "00000000-0000-4000-8000-000000000002";

function messageEvent(args: {
  readonly id: string;
  readonly seqId: number;
  readonly content: string;
}): ChatEvent {
  return chatEventSchema.parse({
    id: args.id,
    threadId: THREAD_ID,
    eventType: "output.message",
    content: args.content,
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: `2026-08-25T10:00:${args.seqId.toString().padStart(2, "0")}Z`,
  });
}

function toolEvent(args: {
  readonly id: string;
  readonly seqId: number;
  readonly toolUseId: string;
  readonly action: OutputToolPayload["action"];
  readonly status: OutputToolPayload["status"];
  readonly summary: string;
}): ChatToolEvent {
  const event = chatEventSchema.parse({
    id: args.id,
    threadId: THREAD_ID,
    eventType: "output.tool",
    content: null,
    runId: RUN_ID,
    seqId: args.seqId,
    createdAt: `2026-08-25T10:00:${args.seqId.toString().padStart(2, "0")}Z`,
    toolUseId: args.toolUseId,
    action: args.action,
    status: args.status,
    summary: args.summary,
  });
  if (event.eventType !== "output.tool") {
    throw new Error("Expected a tool event");
  }
  return event;
}

function semanticEvents(
  events: readonly ProjectedChatEvent[],
  chatToolActivityEnabled: boolean,
): ProjectedChatEvent[] {
  return semanticChatEventsFromChatEvents(events, chatToolActivityEnabled).map(
    (entry) => {
      return entry.event;
    },
  );
}

describe("chat tool activity projection", () => {
  it("keeps retained tool snapshots out of the semantic timeline while the switch is off", () => {
    const events = [
      messageEvent({ id: "message-a", seqId: 1, content: "Before" }),
      toolEvent({
        id: "tool-a",
        seqId: 2,
        toolUseId: "tool-use-a",
        action: "read",
        status: "success",
        summary: "Read src/auth/session.ts",
      }),
      messageEvent({ id: "message-b", seqId: 3, content: "After" }),
    ];

    expect(
      semanticEvents(events, false).map((event) => {
        return event.id;
      }),
    ).toStrictEqual(["message-a", "message-b"]);
    expect(events[1]?.eventType).toBe("output.tool");
  });

  it.each(["success", "error", "cancelled"] as const)(
    "anchors pending to %s at the first row and takes the latest semantic payload",
    (status) => {
      const pending = toolEvent({
        id: `tool-${status}-pending`,
        seqId: 1,
        toolUseId: `tool-use-${status}`,
        action: "run",
        status: "pending",
        summary: "Running command",
      });
      const terminal = toolEvent({
        id: `tool-${status}-terminal`,
        seqId: 2,
        toolUseId: pending.toolUseId,
        action: "edit",
        status,
        summary: "Edited src/auth/session.ts",
      });

      expect(
        projectToolActivitySnapshots([pending, terminal], true),
      ).toStrictEqual([
        {
          ...pending,
          action: "edit",
          status,
          summary: "Edited src/auth/session.ts",
        },
      ]);
      expect(pending).toMatchObject({
        id: `tool-${status}-pending`,
        action: "run",
        status: "pending",
        summary: "Running command",
      });
    },
  );

  it("renders completed-only operations once and folds duplicate retry snapshots", () => {
    const completed = toolEvent({
      id: "tool-completed-only",
      seqId: 1,
      toolUseId: "tool-use-completed-only",
      action: "write",
      status: "success",
      summary: "Wrote generated/report.md",
    });
    const retry = toolEvent({
      id: "tool-completed-only-retry",
      seqId: 2,
      toolUseId: completed.toolUseId,
      action: "write",
      status: "success",
      summary: "Wrote generated/report.md",
    });

    expect(projectToolActivitySnapshots([completed], true)).toStrictEqual([
      completed,
    ]);
    expect(
      projectToolActivitySnapshots([completed, retry], true),
    ).toStrictEqual([completed]);
  });

  it("preserves message and four-action anchor order without grouping by run metadata", () => {
    const events = [
      messageEvent({ id: "message-a", seqId: 1, content: "Message A" }),
      toolEvent({
        id: "tool-run",
        seqId: 2,
        toolUseId: "tool-use-run",
        action: "run",
        status: "success",
        summary: "Ran git status --short",
      }),
      toolEvent({
        id: "tool-read",
        seqId: 3,
        toolUseId: "tool-use-read",
        action: "read",
        status: "success",
        summary: "Read src/auth/session.ts",
      }),
      messageEvent({ id: "message-b", seqId: 4, content: "Message B" }),
      toolEvent({
        id: "tool-write",
        seqId: 5,
        toolUseId: "tool-use-write",
        action: "write",
        status: "success",
        summary: "Wrote generated/report.md",
      }),
      toolEvent({
        id: "tool-edit",
        seqId: 6,
        toolUseId: "tool-use-edit",
        action: "edit",
        status: "success",
        summary: "Edited src/auth/session.ts",
      }),
      messageEvent({ id: "message-final", seqId: 7, content: "Final" }),
    ];

    expect(
      semanticEvents(events, true).map((event) => {
        return event.id;
      }),
    ).toStrictEqual([
      "message-a",
      "tool-run",
      "tool-read",
      "message-b",
      "tool-write",
      "tool-edit",
      "message-final",
    ]);
  });

  it("produces the same latest operation from incremental and full-history replay", () => {
    const pending = toolEvent({
      id: "tool-stream-pending",
      seqId: 1,
      toolUseId: "tool-use-stream",
      action: "run",
      status: "pending",
      summary: "Running pnpm lint",
    });
    const pendingRetry = toolEvent({
      id: "tool-stream-pending-retry",
      seqId: 2,
      toolUseId: pending.toolUseId,
      action: "run",
      status: "pending",
      summary: "Running pnpm lint",
    });
    const success = toolEvent({
      id: "tool-stream-success",
      seqId: 3,
      toolUseId: pending.toolUseId,
      action: "run",
      status: "success",
      summary: "Ran pnpm lint",
    });
    const successRetry = toolEvent({
      id: "tool-stream-success-retry",
      seqId: 4,
      toolUseId: pending.toolUseId,
      action: "run",
      status: "success",
      summary: "Ran pnpm lint",
    });

    expect(projectToolActivitySnapshots([pending], true)).toMatchObject([
      { id: pending.id, status: "pending" },
    ]);
    const incremental = projectToolActivitySnapshots(
      [pending, pendingRetry, success, successRetry],
      true,
    );
    const replay = projectToolActivitySnapshots(
      [pending, pendingRetry, success, successRetry],
      true,
    );
    expect(incremental).toStrictEqual(replay);
    expect(replay).toMatchObject([
      {
        id: pending.id,
        seqId: pending.seqId,
        status: "success",
        summary: "Ran pnpm lint",
      },
    ]);
  });
});
