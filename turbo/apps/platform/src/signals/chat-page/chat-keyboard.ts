import { command } from "ccstate";
import { matchShortcut } from "@vm0/ui";
import { chatThreads$, currentChatThreadId$ } from "../agent-chat.ts";
import { navigateToChat$ } from "../zero-page/zero-nav.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { onDomEventFn } from "../utils.ts";
import { currentChatThreadSignals$ } from "./create-chat-thread.ts";

const navigateToAdjacentThread$ = command(
  async (
    { get, set },
    direction: "prev" | "next",
    signal: AbortSignal,
  ): Promise<void> => {
    const currentId = get(currentChatThreadId$);
    if (!currentId) {
      return;
    }
    const threads = await get(chatThreads$);
    signal.throwIfAborted();
    const idx = threads.findIndex((t) => {
      return t.id === currentId;
    });
    if (idx === -1) {
      return;
    }
    if (direction === "prev" && idx === 0) {
      // Escape upwards from the first thread to the agent chat page.
      const agentId = threads[0]!.agentId;
      set(detachedNavigateTo$, "/agents/:agentId/chat", {
        pathParams: { agentId },
      });
      return;
    }
    const targetIdx = direction === "prev" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= threads.length) {
      return;
    }
    set(navigateToChat$, threads[targetIdx]!.id);
  },
);

const scrollCurrentThread$ = command(
  ({ get, set }, position: "top" | "bottom") => {
    const thread = get(currentChatThreadSignals$);
    if (!thread) {
      return;
    }
    if (position === "top") {
      set(thread.scrollToTop$);
    } else {
      set(thread.scrollToBottom$);
    }
  },
);

// Keyboard shortcuts for the chat thread page.
//
// These run even while focus is in the composer textarea, so we attach the
// listener directly to `document` instead of going through setupGlobalShortcut
// (which filters out editable targets).
//
// - mod+up / mod+down        → scroll messages to top / bottom
// - mod+shift+up / shift+down → jump to previous / next thread in the list
//   (mod+shift+up on the first thread escapes to /agents/:agentId/chat;
//    mod+shift+down on the last thread is a no-op)
export const setupChatPageKeyboard$ = command(
  ({ set }, signal: AbortSignal) => {
    document.addEventListener(
      "keydown",
      onDomEventFn(async (e: KeyboardEvent) => {
        if (e.defaultPrevented) {
          return;
        }
        if (matchShortcut("mod+arrowup", e)) {
          e.preventDefault();
          set(scrollCurrentThread$, "top");
          return;
        }
        if (matchShortcut("mod+arrowdown", e)) {
          e.preventDefault();
          set(scrollCurrentThread$, "bottom");
          return;
        }
        if (matchShortcut("mod+shift+arrowup", e)) {
          e.preventDefault();
          await set(navigateToAdjacentThread$, "prev", signal);
          return;
        }
        if (matchShortcut("mod+shift+arrowdown", e)) {
          e.preventDefault();
          await set(navigateToAdjacentThread$, "next", signal);
          return;
        }
      }),
      { signal },
    );
  },
);
