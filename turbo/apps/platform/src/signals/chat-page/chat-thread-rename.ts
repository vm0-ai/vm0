import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-panes.ts";
import {
  eventDrivenChatThreadMeta,
  type ThreadMeta,
} from "./chat-thread-event-sourcing.ts";
import { openRenameChatThreadDialog$ } from "../zero-page/zero-sidebar-state.ts";
import { renameChatThread$ } from "./chat-message.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
} from "./chat-thread-title.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";

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

function chatThreadEventSourcingEnabled(
  features: Partial<Record<FeatureSwitchKey, boolean>>,
) {
  return features[FeatureSwitchKey.ChatThreadEventSourcing] ?? false;
}

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
    let threadMeta: ThreadMeta | null = null;
    if (chatThreadEventSourcingEnabled(get(featureSwitch$))) {
      threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    } else {
      const thread = paneThreadForId(
        threadId,
        get(currentLeftThread$),
        get(currentRightThread$),
      );
      threadMeta = thread ? await get(thread.threadMeta$) : null;
    }
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
  ({ get, set }, threadId: string) => {
    if (chatThreadEventSourcingEnabled(get(featureSwitch$))) {
      return;
    }
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
    let threadMeta: ThreadMeta | null = null;
    if (chatThreadEventSourcingEnabled(get(featureSwitch$))) {
      threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    } else {
      const thread = paneThreadForId(
        threadId,
        get(currentLeftThread$),
        get(currentRightThread$),
      );
      threadMeta = thread ? await get(thread.threadMeta$) : null;
    }
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
    let threadMeta: ThreadMeta | null = null;
    if (chatThreadEventSourcingEnabled(get(featureSwitch$))) {
      threadMeta = await get(eventDrivenChatThreadMeta(threadId));
    } else {
      const thread = paneThreadForId(
        threadId,
        get(currentLeftThread$),
        get(currentRightThread$),
      );
      threadMeta = thread ? await get(thread.threadMeta$) : null;
    }
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
