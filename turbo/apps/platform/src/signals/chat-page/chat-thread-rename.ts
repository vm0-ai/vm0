import { command } from "ccstate";
import { eventDrivenChatThreadMeta } from "./chat-thread-event-sourcing.ts";
import { openRenameChatThreadDialog$ } from "../zero-page/zero-sidebar-state.ts";
import { renameChatThread$ } from "./chat-message.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
} from "./chat-thread-title.ts";

export interface RenameChatThreadDialogRequest {
  readonly threadId: string;
  readonly title?: string | null;
  readonly agentId?: string | null;
}

export const openRenameChatThreadDialogFromThreadData$ = command(
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
    const threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    signal.throwIfAborted();
    set(
      openRenameChatThreadDialogFromThreadData$,
      {
        threadId,
        title: threadMeta?.title,
        agentId: threadMeta?.agentId,
      },
      signal,
    );
  },
);

export const reloadChatThreadDataForId$ = command(
  (_context, _threadId: string) => {
    return undefined;
  },
);

export const setChatThreadEmojiFromThreadData$ = command(
  async (
    { get, set },
    {
      threadId,
      emoji,
      title,
    }: { threadId: string; emoji: string; title?: string | null },
    signal: AbortSignal,
  ) => {
    const threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    signal.throwIfAborted();
    const currentTitle = title !== undefined ? title : threadMeta?.title;
    await set(
      renameChatThread$,
      {
        threadId,
        title: applyChatThreadEmoji(currentTitle, emoji),
        agentId: threadMeta?.agentId,
      },
      signal,
    );
    set(reloadChatThreadDataForId$, threadId);
  },
);

export const clearChatThreadEmojiFromThreadData$ = command(
  async (
    { get, set },
    { threadId, title }: { threadId: string; title?: string | null },
    signal: AbortSignal,
  ) => {
    const threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    signal.throwIfAborted();
    const currentTitle = title !== undefined ? title : threadMeta?.title;
    const nextTitle = removeChatThreadEmoji(currentTitle);
    if (!nextTitle) {
      return;
    }
    await set(
      renameChatThread$,
      { threadId, title: nextTitle, agentId: threadMeta?.agentId },
      signal,
    );
    set(reloadChatThreadDataForId$, threadId);
  },
);
