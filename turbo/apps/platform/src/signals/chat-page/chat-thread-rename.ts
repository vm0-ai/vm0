import { command } from "ccstate";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "./chat-thread-panes.ts";
import { openRenameChatThreadDialog$ } from "../zero-page/zero-sidebar-state.ts";

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
