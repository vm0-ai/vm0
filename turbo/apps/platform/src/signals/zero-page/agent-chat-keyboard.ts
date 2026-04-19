import { command } from "ccstate";
import { matchShortcut } from "@vm0/ui";
import { chatThreads$ } from "../agent-chat.ts";
import { navigateToChat$ } from "./zero-nav.ts";
import { onDomEventFn } from "../utils.ts";

const navigateToFirstThread$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const threads = await get(chatThreads$);
    signal.throwIfAborted();
    if (threads.length === 0) {
      return;
    }
    set(navigateToChat$, threads[0]!.id);
  },
);

// Keyboard shortcuts for the agent chat landing page (/agents/:agentId/chat).
//
// Listener is attached to `document` so it fires even while focus is inside
// the composer textarea, mirroring setupChatPageKeyboard$ on the thread page.
//
// - mod+shift+down → jump into the first thread in the list (no-op when empty)
export const setupAgentChatPageKeyboard$ = command(
  ({ set }, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      onDomEventFn(async (e: KeyboardEvent) => {
        if (e.defaultPrevented) {
          return;
        }
        if (matchShortcut("mod+shift+arrowdown", e)) {
          e.preventDefault();
          await set(navigateToFirstThread$, signal);
          return;
        }
      }),
      { signal },
    );
  },
);
