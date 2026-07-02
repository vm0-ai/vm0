import { command } from "ccstate";
import { matchShortcut } from "@vm0/ui";
import { sidebarChatThreads$ } from "../chat-page/optimistic-chat-thread-page.ts";
import { onDomEventFn } from "../utils.ts";
import { navigateToChat$ } from "./zero-nav.ts";

export const setupAgentChatKeyboardShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      onDomEventFn(async (event: KeyboardEvent) => {
        if (
          event.defaultPrevented ||
          !matchShortcut("mod+shift+arrowdown", event)
        ) {
          return;
        }

        event.preventDefault();
        const [firstThread] = await get(sidebarChatThreads$);
        signal.throwIfAborted();
        if (!firstThread) {
          return;
        }
        set(navigateToChat$, firstThread.id);
      }),
      { signal },
    );
  },
);
