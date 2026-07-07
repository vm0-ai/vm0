import { command } from "ccstate";
import { chatThreadMetaMap$ } from "./chat-thread-event-sourcing.ts";
import { openRenameChatThreadDialog$ } from "../zero-page/zero-sidebar-state.ts";

export interface RenameChatThreadDialogRequest {
  readonly threadId: string;
  readonly title?: string | null;
  readonly agentId?: string | null;
}

export const openRenameChatThreadDialogFromThreadMeta$ = command(
  ({ set }, request: RenameChatThreadDialogRequest, _signal: AbortSignal) => {
    set(openRenameChatThreadDialog$, {
      threadId: request.threadId,
      title: request.title,
      agentId: request.agentId,
    });
  },
);

export const openRenameChatThreadDialogForThreadId$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const meta = (await get(chatThreadMetaMap$)).get(threadId) ?? null;
    signal.throwIfAborted();
    set(
      openRenameChatThreadDialogFromThreadMeta$,
      {
        threadId,
        title: meta?.title,
        agentId: meta?.agentId,
      },
      signal,
    );
  },
);
