import { command } from "ccstate";
import { currentChatAgentId$, setChatAgentId$ } from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { resetSignal } from "../utils.ts";
import { createIdbCachedDataSource } from "./idb-cached-chat-thread-data-source.ts";
import { eventDrivenChatThreadMeta } from "./chat-thread-event-sourcing.ts";

const resetSyncPrimarySignal$ = resetSignal();

/**
 * Drives the document title, the global agent context, and the Ably
 * title-update loop in response to whichever thread is showing in the
 * primary (left) pane. Decoupled from `chat-thread-panes.ts` so the pane
 * wiring stays focused on per-pane state, optimistic swaps, and URL.
 *
 * Lifecycle: call once per primary-thread switch with the new threadId
 * and parentSignal. The internal reset signal aborts any previous Ably
 * loop before the new one starts. Missing remote detail silently returns:
 * the visible pane renders its own missing-thread state.
 *
 * Owns its own data source (Option A from the plan) so it doesn't have to
 * thread state through the pane wiring. On non-IDB users this issues one
 * extra `chat-threads/:id` GET that the pane setup also fires; on IDB users
 * the second GET is collapsed by the cache.
 */
export const syncPrimaryThread$ = command(
  async (
    { get, set },
    threadId: string,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(resetSyncPrimarySignal$, parentSignal);

    // Initial title, set synchronously so the document tab updates on the
    // very first frame after the pane switch.
    set(updateDocumentTitle$, "Chat");

    const threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    signal.throwIfAborted();
    if (threadMeta) {
      const currentAgentId = await get(currentChatAgentId$);
      signal.throwIfAborted();
      if (currentAgentId !== threadMeta.agentId) {
        set(setChatAgentId$, threadMeta.agentId);
      }

      set(updateDocumentTitle$, threadMeta.title ?? "New chat");
    }

    const dataSource = createIdbCachedDataSource(threadId);
    const remoteThreadDetail = await get(dataSource.remoteThreadDetail$);
    signal.throwIfAborted();
    if (!threadMeta && !remoteThreadDetail) {
      return;
    }

    if (!threadMeta && remoteThreadDetail) {
      const currentAgentId = await get(currentChatAgentId$);
      signal.throwIfAborted();
      if (currentAgentId !== remoteThreadDetail.agentId) {
        set(setChatAgentId$, remoteThreadDetail.agentId);
      }
      set(updateDocumentTitle$, remoteThreadDetail.title ?? "New chat");
    }

    // Forever-running Ably loop until signal aborts.
    const onThreadUpdated$ = command(async ({ get, set }, sig: AbortSignal) => {
      const data = await get(dataSource.remoteThreadDetail$);
      sig.throwIfAborted();
      if (data) {
        set(updateDocumentTitle$, data.title ?? "New chat");
      }
      return false;
    });
    await set(
      setAblyLoop$,
      {
        topic: `chatThreadRunUpdated:${threadId}`,
        loopCommand$: onThreadUpdated$,
      },
      signal,
    );
  },
);
