import { command } from "ccstate";
import { currentChatThreadListIds$ } from "../agent-chat.ts";
import {
  currentLeftThread$,
  loadLeftThread$,
} from "../chat-page/chat-thread-panes.ts";
import { onDomEventFn, onRef } from "../utils.ts";
import { navigateToChat$, setSidebarExpanded$ } from "./nav.ts";
import { threadQuickSwitchIndex$ } from "./thread-quick-switch.ts";

export const setThreadListQuickSwitchRoot$ = onRef(
  command(({ get, set }, element: HTMLElement, signal: AbortSignal) => {
    const doc = element.ownerDocument;
    doc.addEventListener(
      "keydown",
      onDomEventFn(async (event: KeyboardEvent) => {
        if (doc.querySelector('[role="dialog"], [role="menu"]')) {
          return;
        }
        const index = set(threadQuickSwitchIndex$, event);
        if (index === undefined) {
          return;
        }
        event.preventDefault();
        const threadIds = get(currentChatThreadListIds$);
        const threadId = (await threadIds)[index];
        signal.throwIfAborted();
        if (!threadId || get(currentChatThreadListIds$) !== threadIds) {
          return;
        }
        if (get(currentLeftThread$)) {
          set(loadLeftThread$, threadId);
        } else {
          set(navigateToChat$, threadId);
        }
        set(setSidebarExpanded$, false);
      }),
      { signal },
    );
  }),
);
