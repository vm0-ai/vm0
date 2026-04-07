import { state, computed, command } from "ccstate";
import { throwIfAbort } from "../utils.ts";

// ---------------------------------------------------------------------------
// Collapsible timeline expanded state
// ---------------------------------------------------------------------------

const expandedTimelineIds$ = state(new Set<string>());

export const timelineExpandedIds$ = computed((get) => {
  return get(expandedTimelineIds$);
});

export const toggleTimelineExpanded$ = command(
  ({ get, set }, messageId: string) => {
    const current = get(expandedTimelineIds$);
    const next = new Set(current);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    set(expandedTimelineIds$, next);
  },
);

// ---------------------------------------------------------------------------
// Copy message state
// ---------------------------------------------------------------------------

const copiedMessageId$ = state<string | null>(null);

export const copiedMessageIdValue$ = computed((get) => {
  return get(copiedMessageId$);
});

export const copyMessageContent$ = command(
  async ({ set }, messageId: string, content: string, signal: AbortSignal) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch (error: unknown) {
      throwIfAbort(error);
      // Clipboard API can throw NotAllowedError on iOS Safari when the user
      // gesture context is lost (e.g. after an async boundary). Fall back to
      // the legacy execCommand approach.
      try {
        const textarea = document.createElement("textarea");
        textarea.value = content;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      } catch (fallbackError: unknown) {
        throwIfAbort(fallbackError);
        // Both methods failed — nothing more we can do.
        return;
      }
    }
    signal.throwIfAborted();
    set(copiedMessageId$, messageId);
    window.setTimeout(() => {
      return set(copiedMessageId$, null);
    }, 2000);
  },
);
