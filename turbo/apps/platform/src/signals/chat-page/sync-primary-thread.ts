import { command } from "ccstate";
import { currentChatAgentId$, setChatAgentId$ } from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { resetSignal } from "../utils.ts";
import { threadMeta, type ThreadMeta } from "./chat-thread-event-sourcing.ts";
import { i18n } from "../../i18n/index.ts";

const resetSyncPrimarySignal$ = resetSignal();

const beginPrimaryThreadSync$ = command(
  ({ set }, parentSignal: AbortSignal): AbortSignal => {
    const signal = set(resetSyncPrimarySignal$, parentSignal);
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.chat.documentTitle;
      }),
    );
    return signal;
  },
);

export const syncMissingPrimaryThread$ = command(
  ({ set }, parentSignal: AbortSignal): void => {
    set(beginPrimaryThreadSync$, parentSignal);
  },
);

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
    meta: ThreadMeta,
    parentSignal: AbortSignal,
  ): Promise<void> => {
    const signal = set(beginPrimaryThreadSync$, parentSignal);
    const threadId = meta.id;
    const threadMeta$ = threadMeta(threadId);

    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (currentAgentId !== meta.agentId) {
      set(setChatAgentId$, meta.agentId);
    }

    set(
      updateDocumentTitle$,
      meta.title ??
        i18n.t(($) => {
          return $.chat.newChat;
        }),
    );

    // Forever-running Ably loop until signal aborts.
    const onThreadUpdated$ = command(({ get, set }) => {
      const updatedMeta = get(threadMeta$);
      if (updatedMeta) {
        set(
          updateDocumentTitle$,
          updatedMeta.title ??
            i18n.t(($) => {
              return $.chat.newChat;
            }),
        );
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
