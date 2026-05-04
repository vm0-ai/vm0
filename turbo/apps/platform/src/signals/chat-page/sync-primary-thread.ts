import { command } from "ccstate";
import { currentChatAgentId$, setChatAgentId$ } from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { idbMessageEnabled$ } from "../external/feature-switch.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { resetSignal } from "../utils.ts";
import { createIdbCachedDataSource } from "./idb-cached-chat-thread-data-source.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import { optimisticChatThread$ } from "./optimistic-chat-thread-state.ts";

const resetSyncPrimarySignal$ = resetSignal();

/**
 * Drives the document title, the global agent context, and the Ably
 * title-update loop in response to whichever thread is showing in the
 * primary (left) pane. Decoupled from `chat-thread-panes.ts` so the pane
 * wiring stays focused on per-pane state, optimistic swaps, and URL.
 *
 * Lifecycle: call once per primary-thread switch with the new threadId
 * and parentSignal. The internal reset signal aborts any previous Ably
 * loop before the new one starts. 404 silently returns — the pane setup
 * path already throws on missing thread data; no need to double-error.
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
    const optimistic = get(optimisticChatThread$);
    const isOptimistic = optimistic?.threadId === threadId;
    set(updateDocumentTitle$, isOptimistic ? "New chat" : "Chat");

    const idbEnabled = await get(idbMessageEnabled$);
    signal.throwIfAborted();
    const dataSource = idbEnabled
      ? createIdbCachedDataSource(threadId)
      : createRemoteChatThreadDataSource(threadId);

    const threadData = await get(dataSource.getThread$);
    signal.throwIfAborted();
    if (!threadData) {
      // pane setup throws "Thread data missing" on the same condition; no
      // value in double-erroring here.
      return;
    }

    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId !== threadData.agentId) {
      set(setChatAgentId$, threadData.agentId);
    }

    set(updateDocumentTitle$, threadData.title ?? "New chat");

    // Forever-running Ably loop until signal aborts.
    const onThreadUpdated$ = command(async ({ get, set }, sig: AbortSignal) => {
      const data = await get(dataSource.getThread$);
      sig.throwIfAborted();
      if (data) {
        set(updateDocumentTitle$, data.title ?? "New chat");
      }
      return false;
    });
    await set(
      setAblyLoop$,
      `chatThreadRunUpdated:${threadId}`,
      onThreadUpdated$,
      signal,
    );
  },
);
