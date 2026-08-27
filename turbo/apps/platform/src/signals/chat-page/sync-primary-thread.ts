import { command } from "ccstate";
import { currentChatAgentId$, setChatAgentId$ } from "../agent-chat.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import { i18n } from "../../i18n/index.ts";

const resetDocumentTitle$ = command(({ set }) => {
  set(
    updateDocumentTitle$,
    i18n.t(($) => {
      return $.chat.documentTitle;
    }),
  );
});

export const syncMissingPrimaryThread$ = command(({ set }): void => {
  set(resetDocumentTitle$);
});

/** Keep the document title and global agent context aligned with the thread. */
export const syncPrimaryThread$ = command(
  async (
    { get, set },
    meta: ThreadMeta,
    signal: AbortSignal,
  ): Promise<void> => {
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
  },
);
