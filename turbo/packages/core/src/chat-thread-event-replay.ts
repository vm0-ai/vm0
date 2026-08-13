import type {
  ChatThreadEvent,
  ChatThreadSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-threads";

export type ReplayChatThreadEvent = Omit<ChatThreadEvent, "seqId">;

export interface EventDrivenChatThread extends ChatThreadSnapshotProjection {
  readonly sortAt: string;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
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

/**
 * Updates that can arrive before the `created` event they belong to. They are
 * queued and replayed once the thread exists; every other kind is dropped.
 */
function isDeferrableUpdate(kind: ReplayChatThreadEvent["kind"]): boolean {
  return (
    kind === "model_selection_updated" ||
    kind === "service_tier_updated" ||
    kind === "computer_use_host_updated" ||
    kind === "video_model_updated"
  );
}

/**
 * Fields an event writes onto an existing thread, or null for `sort_touched`,
 * which moves the thread without counting as an update.
 */
function updatedThreadFields(
  event: ReplayChatThreadEvent,
): Partial<EventDrivenChatThread> | null {
  if (event.kind === "renamed") {
    return { title: event.title, renamedAt: event.createdAt };
  }
  if (event.kind === "pinned") {
    return { pinnedAt: event.createdAt };
  }
  if (event.kind === "unpinned") {
    return { pinnedAt: null };
  }
  if (event.kind === "model_selection_updated") {
    return { selectedModel: event.selectedModel };
  }
  if (event.kind === "service_tier_updated") {
    return { serviceTier: event.serviceTier };
  }
  if (event.kind === "computer_use_host_updated") {
    return {
      computerUseHostId: event.computerUseHostId,
      cloudBrowserEnabled: event.cloudBrowserEnabled ?? false,
    };
  }
  if (event.kind === "video_model_updated") {
    return { selectedVideoModel: event.selectedVideoModel ?? null };
  }
  return null;
}

function applyEvent(
  threads: Map<string, EventDrivenChatThread>,
  event: ReplayChatThreadEvent,
  pendingThreadUpdates: Map<string, ReplayChatThreadEvent[]>,
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
      selectedModel: event.selectedModel,
      serviceTier: event.serviceTier,
      computerUseHostId: event.computerUseHostId,
      cloudBrowserEnabled: event.cloudBrowserEnabled ?? false,
      selectedVideoModel: event.selectedVideoModel ?? null,
    });
    const pendingUpdates = pendingThreadUpdates.get(event.chatThreadId) ?? [];
    pendingThreadUpdates.delete(event.chatThreadId);
    for (const pendingUpdate of pendingUpdates) {
      if (pendingUpdate.createdAt.localeCompare(event.createdAt) >= 0) {
        applyEvent(threads, pendingUpdate, pendingThreadUpdates);
      }
    }
    return;
  }

  if (event.kind === "deleted") {
    threads.delete(event.chatThreadId);
    return;
  }

  const thread = threads.get(event.chatThreadId);
  if (!thread) {
    if (isDeferrableUpdate(event.kind)) {
      const pendingUpdates = pendingThreadUpdates.get(event.chatThreadId) ?? [];
      pendingThreadUpdates.set(event.chatThreadId, [...pendingUpdates, event]);
    }
    return;
  }

  const fields = updatedThreadFields(event);
  if (fields === null) {
    threads.set(event.chatThreadId, {
      ...thread,
      sortAt: event.createdAt,
    });
    return;
  }

  threads.set(event.chatThreadId, {
    ...thread,
    ...fields,
    updatedAt: event.createdAt,
  });
}

export function replayChatThreadEvents(
  snapshot: readonly ChatThreadSnapshotProjection[],
  events: readonly ReplayChatThreadEvent[],
): EventDrivenChatThread[] {
  const threads = new Map<string, EventDrivenChatThread>();
  for (const thread of snapshot) {
    threads.set(thread.id, {
      ...thread,
      selectedModel: thread.selectedModel ?? null,
      serviceTier: thread.serviceTier ?? null,
      computerUseHostId: thread.computerUseHostId ?? null,
      cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
      selectedVideoModel: thread.selectedVideoModel ?? null,
    });
  }
  const pendingThreadUpdates = new Map<string, ReplayChatThreadEvent[]>();
  for (const event of events) {
    applyEvent(threads, event, pendingThreadUpdates);
  }
  return [...threads.values()].sort(compareThreadOrder);
}
