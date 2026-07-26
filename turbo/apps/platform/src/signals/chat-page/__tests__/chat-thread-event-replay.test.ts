import { describe, expect, it } from "vitest";
import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";
import { replayChatThreadEvents } from "@vm0/core/chat-thread-event-replay";

function snapshotThread(
  params: Partial<ChatThreadSnapshotProjection> & {
    readonly id: string;
    readonly agentId: string;
    readonly sortAt: string;
  },
): ChatThreadSnapshotProjection {
  return {
    title: null,
    createdAt: params.sortAt,
    updatedAt: params.sortAt,
    pinnedAt: null,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    computerUseHostId: null,
    ...params,
  };
}

function event(
  params: Omit<
    ChatThreadEvent,
    "id" | "createdAt" | "selectedModel" | "serviceTier" | "computerUseHostId"
  > & {
    readonly id: string;
    readonly createdAt: string;
    readonly selectedModel?: string | null;
    readonly serviceTier?: "priority" | null;
    readonly computerUseHostId?: string | null;
  },
): ChatThreadEvent {
  return {
    ...params,
    selectedModel: params.selectedModel ?? null,
    serviceTier: params.serviceTier ?? null,
    computerUseHostId: params.computerUseHostId ?? null,
  };
}

describe("replayChatThreadEvents", () => {
  it("replays lifecycle events over snapshot threads", () => {
    const result = replayChatThreadEvents(
      [
        snapshotThread({
          id: "thread-a",
          agentId: "agent-1",
          title: "Old title",
          sortAt: "2026-07-01T00:00:00.000Z",
        }),
      ],
      [
        event({
          id: "event-1",
          kind: "renamed",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: "New title",
          createdAt: "2026-07-01T01:00:00.000Z",
        }),
        event({
          id: "event-2",
          kind: "sort_touched",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          createdAt: "2026-07-01T02:00:00.000Z",
        }),
        event({
          id: "event-3",
          kind: "created",
          chatThreadId: "thread-b",
          agentId: "agent-1",
          title: "Created thread",
          createdAt: "2026-07-01T03:00:00.000Z",
        }),
        event({
          id: "event-4",
          kind: "deleted",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          createdAt: "2026-07-01T04:00:00.000Z",
        }),
      ],
    );

    expect(result).toStrictEqual([
      {
        id: "thread-b",
        agentId: "agent-1",
        title: "Created thread",
        sortAt: "2026-07-01T03:00:00.000Z",
        createdAt: "2026-07-01T03:00:00.000Z",
        updatedAt: "2026-07-01T03:00:00.000Z",
        pinnedAt: null,
        renamedAt: null,
        selectedModel: null,
        serviceTier: null,
        computerUseHostId: null,
      },
    ]);
  });

  it("sorts pinned threads before unpinned threads", () => {
    const result = replayChatThreadEvents(
      [
        snapshotThread({
          id: "thread-a",
          agentId: "agent-1",
          sortAt: "2026-07-01T03:00:00.000Z",
        }),
        snapshotThread({
          id: "thread-b",
          agentId: "agent-1",
          sortAt: "2026-07-01T01:00:00.000Z",
        }),
        snapshotThread({
          id: "thread-c",
          agentId: "agent-1",
          sortAt: "2026-07-01T02:00:00.000Z",
        }),
      ],
      [
        event({
          id: "event-1",
          kind: "pinned",
          chatThreadId: "thread-b",
          agentId: "agent-1",
          title: null,
          createdAt: "2026-07-01T04:00:00.000Z",
        }),
      ],
    );

    expect(
      result.map((thread) => {
        return thread.id;
      }),
    ).toStrictEqual(["thread-b", "thread-a", "thread-c"]);
    expect(result[0]?.pinnedAt).toBe("2026-07-01T04:00:00.000Z");
  });

  it("replays selected model updates without touching sort order", () => {
    const result = replayChatThreadEvents(
      [
        snapshotThread({
          id: "thread-a",
          agentId: "agent-1",
          selectedModel: null,
          sortAt: "2026-07-01T03:00:00.000Z",
        }),
        snapshotThread({
          id: "thread-b",
          agentId: "agent-1",
          selectedModel: "gpt-5.4",
          sortAt: "2026-07-01T04:00:00.000Z",
        }),
      ],
      [
        event({
          id: "event-1",
          kind: "model_selection_updated",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          selectedModel: "claude-sonnet-4-6",
          createdAt: "2026-07-01T05:00:00.000Z",
        }),
        event({
          id: "event-2",
          kind: "model_selection_updated",
          chatThreadId: "thread-b",
          agentId: "agent-1",
          title: null,
          selectedModel: null,
          createdAt: "2026-07-01T06:00:00.000Z",
        }),
      ],
    );

    expect(
      result.map((thread) => {
        return {
          id: thread.id,
          selectedModel: thread.selectedModel,
          sortAt: thread.sortAt,
          updatedAt: thread.updatedAt,
        };
      }),
    ).toStrictEqual([
      {
        id: "thread-b",
        selectedModel: null,
        sortAt: "2026-07-01T04:00:00.000Z",
        updatedAt: "2026-07-01T06:00:00.000Z",
      },
      {
        id: "thread-a",
        selectedModel: "claude-sonnet-4-6",
        sortAt: "2026-07-01T03:00:00.000Z",
        updatedAt: "2026-07-01T05:00:00.000Z",
      },
    ]);
  });

  it("replays service tier and Computer Use host updates", () => {
    const computerUseHostId = "11111111-1111-4111-8111-111111111111";
    const [thread] = replayChatThreadEvents(
      [
        snapshotThread({
          id: "thread-a",
          agentId: "agent-1",
          sortAt: "2026-07-01T03:00:00.000Z",
        }),
      ],
      [
        event({
          id: "event-1",
          kind: "service_tier_updated",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          serviceTier: "priority",
          createdAt: "2026-07-01T05:00:00.000Z",
        }),
        event({
          id: "event-2",
          kind: "computer_use_host_updated",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          computerUseHostId,
          createdAt: "2026-07-01T06:00:00.000Z",
        }),
      ],
    );

    expect(thread).toMatchObject({
      serviceTier: "priority",
      computerUseHostId,
      sortAt: "2026-07-01T03:00:00.000Z",
      updatedAt: "2026-07-01T06:00:00.000Z",
    });
  });

  it("applies configuration updates that arrive before same-timestamp creation", () => {
    const sameTimestamp = "2026-07-01T05:00:00.000Z";
    const computerUseHostId = "11111111-1111-4111-8111-111111111111";
    const result = replayChatThreadEvents(
      [],
      [
        event({
          id: "event-1",
          kind: "model_selection_updated",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          selectedModel: "claude-sonnet-4-6",
          createdAt: sameTimestamp,
        }),
        event({
          id: "event-2",
          kind: "service_tier_updated",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          serviceTier: "priority",
          createdAt: sameTimestamp,
        }),
        event({
          id: "event-3",
          kind: "computer_use_host_updated",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: null,
          computerUseHostId,
          createdAt: sameTimestamp,
        }),
        event({
          id: "event-4",
          kind: "created",
          chatThreadId: "thread-a",
          agentId: "agent-1",
          title: "Created thread",
          createdAt: sameTimestamp,
        }),
      ],
    );

    expect(result).toStrictEqual([
      {
        id: "thread-a",
        agentId: "agent-1",
        title: "Created thread",
        sortAt: sameTimestamp,
        createdAt: sameTimestamp,
        updatedAt: sameTimestamp,
        pinnedAt: null,
        renamedAt: null,
        selectedModel: "claude-sonnet-4-6",
        serviceTier: "priority",
        computerUseHostId,
      },
    ]);
  });
});
