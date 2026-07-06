import { command } from "ccstate";
import { currentChatAgentId$, setChatAgentId$ } from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { resetSignal } from "../utils.ts";
import {
  syncEventDrivenChatThreads$,
  threadMeta,
} from "./chat-thread-event-sourcing.ts";

const resetSyncPrimarySignal$ = resetSignal();

/**
 * Drives the document title, the global agent context, and the Ably
 * title-update loop in response to whichever thread is showing in the
 * primary (left) pane. Decoupled from `chat-thread-panes.ts` so the pane
 * wiring stays focused on per-pane state, optimistic swaps, and URL.
 *
 * Lifecycle: call once per primary-thread switch with the new threadId and
 * parentSignal. The internal reset signal aborts any previous Ably loop before
 * the new one starts.
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

    const threadMeta$ = threadMeta(threadId);
    const meta = await get(threadMeta$);
    signal.throwIfAborted();
    if (!meta) {
      return;
    }

    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId !== meta.agentId) {
      set(setChatAgentId$, meta.agentId);
    }

    set(updateDocumentTitle$, meta.title ?? "New chat");

    // Forever-running Ably loop until signal aborts.
    const onThreadUpdated$ = command(async ({ get, set }, sig: AbortSignal) => {
      await set(syncEventDrivenChatThreads$, sig);
      sig.throwIfAborted();
      const updatedMeta = await get(threadMeta$);
      sig.throwIfAborted();
      if (updatedMeta) {
        set(updateDocumentTitle$, updatedMeta.title ?? "New chat");
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
