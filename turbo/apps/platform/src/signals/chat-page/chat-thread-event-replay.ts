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
  pendingSelectedModelUpdates: Map<string, ChatThreadEvent>,
) {
  if (event.kind === "created") {
    const pendingSelectedModelUpdate = pendingSelectedModelUpdates.get(
      event.chatThreadId,
    );
    pendingSelectedModelUpdates.delete(event.chatThreadId);
    const selectedModelUpdate =
      pendingSelectedModelUpdate &&
      pendingSelectedModelUpdate.createdAt.localeCompare(event.createdAt) >= 0
        ? pendingSelectedModelUpdate
        : null;
    threads.set(event.chatThreadId, {
      id: event.chatThreadId,
      agentId: event.agentId,
      title: event.title,
      sortAt: event.createdAt,
      createdAt: event.createdAt,
      updatedAt: selectedModelUpdate?.createdAt ?? event.createdAt,
      pinnedAt: null,
      renamedAt: null,
      selectedModel: selectedModelUpdate?.selectedModel ?? event.selectedModel,
    });
    return;
  }

  if (event.kind === "deleted") {
    threads.delete(event.chatThreadId);
    return;
  }

  const thread = threads.get(event.chatThreadId);
  if (!thread) {
    if (event.kind === "model_selection_updated") {
      pendingSelectedModelUpdates.set(event.chatThreadId, event);
    }
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

  if (event.kind === "model_selection_updated") {
    threads.set(event.chatThreadId, {
      ...thread,
      selectedModel: event.selectedModel,
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
    threads.set(thread.id, {
      ...thread,
      selectedModel: thread.selectedModel ?? null,
    });
  }
  const pendingSelectedModelUpdates = new Map<string, ChatThreadEvent>();
  for (const event of events) {
    applyEvent(threads, event, pendingSelectedModelUpdates);
  }
  return [...threads.values()].sort(compareThreadOrder);
}
