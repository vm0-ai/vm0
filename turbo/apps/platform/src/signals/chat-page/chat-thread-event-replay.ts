import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@vm0/api-contracts/contracts/chat-threads";

export interface EventDrivenChatThread extends ChatThreadSnapshotProjection {
  readonly sortAt: string;
}

function compareThreadOrder(
  left: EventDrivenChatThread,
  right: EventDrivenChatThread,
): number {
  const leftPinned = left.pinnedAt !== null;
  const rightPinned = right.pinnedAt !== null;
  if (leftPinned !== rightPinned) {
    return leftPinned ? -1 : 1;
  }
  const sortCompare = right.sortAt.localeCompare(left.sortAt);
  if (sortCompare !== 0) {
    return sortCompare;
  }
  return right.id.localeCompare(left.id);
}

function applyEvent(
  threads: Map<string, EventDrivenChatThread>,
  event: ChatThreadEvent,
) {
  if (event.kind === "created") {
    threads.set(event.chatThreadId, {
      id: event.chatThreadId,
      agentId: event.agentId,
      title: event.title,
      sortAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: event.createdAt,
      pinnedAt: null,
      renamedAt: null,
    });
    return;
  }

  if (event.kind === "deleted") {
    threads.delete(event.chatThreadId);
    return;
  }

  const thread = threads.get(event.chatThreadId);
  if (!thread) {
    return;
  }

  if (event.kind === "renamed") {
    threads.set(event.chatThreadId, {
      ...thread,
      title: event.title,
      renamedAt: event.createdAt,
      updatedAt: event.createdAt,
    });
    return;
  }

  if (event.kind === "pinned") {
    threads.set(event.chatThreadId, {
      ...thread,
      pinnedAt: event.createdAt,
      updatedAt: event.createdAt,
    });
    return;
  }

  if (event.kind === "unpinned") {
    threads.set(event.chatThreadId, {
      ...thread,
      pinnedAt: null,
      updatedAt: event.createdAt,
    });
    return;
  }

  threads.set(event.chatThreadId, {
    ...thread,
    sortAt: event.createdAt,
  });
}

export function replayChatThreadEvents(
  snapshot: readonly ChatThreadSnapshotProjection[],
  events: readonly ChatThreadEvent[],
): EventDrivenChatThread[] {
  const threads = new Map<string, EventDrivenChatThread>();
  for (const thread of snapshot) {
    threads.set(thread.id, { ...thread });
  }
  for (const event of events) {
    applyEvent(threads, event);
  }
  return [...threads.values()].sort(compareThreadOrder);
}
