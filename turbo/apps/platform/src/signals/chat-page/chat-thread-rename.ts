import { command } from "ccstate";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-panes.ts";
import { openRenameChatThreadDialog$ } from "../zero-page/zero-sidebar-state.ts";
import { renameChatThread$ } from "./chat-message.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
} from "./chat-thread-title.ts";

function paneThreadForId(
  threadId: string,
  leftThread: ChatThreadSignals | null,
  rightThread: ChatThreadSignals | null,
): ChatThreadSignals | null {
  if (leftThread?.threadId === threadId) {
    return leftThread;
  }
  if (rightThread?.threadId === threadId) {
    return rightThread;
  }
  return null;
}

export const openRenameChatThreadDialogFromThreadData$ = command(
  async ({ get, set }, threadId: string, signal: AbortSignal) => {
    const thread = paneThreadForId(
      threadId,
      get(currentLeftThread$),
      get(currentRightThread$),
    );
    const threadData = thread ? await get(thread.threadData$) : null;
    signal.throwIfAborted();
    set(openRenameChatThreadDialog$, {
      threadId,
      title: threadData?.title,
    });
  },
);

export const reloadChatThreadDataForId$ = command(
  ({ get, set }, threadId: string) => {
    const leftThread = get(currentLeftThread$);
    if (leftThread?.threadId === threadId) {
      set(leftThread.reloadThread$);
    }
    const rightThread = get(currentRightThread$);
    if (rightThread?.threadId === threadId) {
      set(rightThread.reloadThread$);
    }
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
    const thread = paneThreadForId(
      threadId,
      get(currentLeftThread$),
      get(currentRightThread$),
    );
    const threadData = thread ? await get(thread.threadData$) : null;
    signal.throwIfAborted();
    const currentTitle = title !== undefined ? title : threadData?.title;
    await set(
      renameChatThread$,
      { threadId, title: applyChatThreadEmoji(currentTitle, emoji) },
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
    const thread = paneThreadForId(
      threadId,
      get(currentLeftThread$),
      get(currentRightThread$),
    );
    const threadData = thread ? await get(thread.threadData$) : null;
    signal.throwIfAborted();
    const currentTitle = title !== undefined ? title : threadData?.title;
    const nextTitle = removeChatThreadEmoji(currentTitle);
    if (!nextTitle) {
      return;
    }
    await set(renameChatThread$, { threadId, title: nextTitle }, signal);
    set(reloadChatThreadDataForId$, threadId);
  },
);
