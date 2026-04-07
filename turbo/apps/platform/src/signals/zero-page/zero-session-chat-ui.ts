import { state, computed, command } from "ccstate";
import { writeToClipboard } from "./clipboard.ts";

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
    const ok = await writeToClipboard(content);
    signal.throwIfAborted();
    if (!ok) {
      return;
    }
    set(copiedMessageId$, messageId);
    window.setTimeout(() => {
      return set(copiedMessageId$, null);
    }, 2000);
  },
);
