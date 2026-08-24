import { command } from "ccstate";
import { matchShortcut } from "@okouai/ui";
import { currentChatThreadListIds$ } from "../agent-chat.ts";
import { onDomEventFn } from "../utils.ts";
import { navigateToChat$ } from "./nav.ts";

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
        const [firstThreadId] = await get(currentChatThreadListIds$);
        signal.throwIfAborted();
        if (!firstThreadId) {
          return;
        }
        set(navigateToChat$, firstThreadId);
      }),
      { signal },
    );
  },
);
