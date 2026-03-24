import { state, computed, command } from "ccstate";

// ---------------------------------------------------------------------------
// Collapsible timeline expanded state
// ---------------------------------------------------------------------------

const expandedTimelineIds$ = state(new Set<string>());

export const timelineExpandedIds$ = computed((get) =>
  get(expandedTimelineIds$),
);

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

export const copiedMessageIdValue$ = computed((get) => get(copiedMessageId$));

export const copyMessageContent$ = command(
  ({ set }, messageId: string, content: string) => {
    return navigator.clipboard
      .writeText(content)
      .then(() => {
        set(copiedMessageId$, messageId);
        window.setTimeout(() => set(copiedMessageId$, null), 2000);
      })
      .catch(() => {
        /* clipboard unavailable – no feedback shown */
      });
  },
);
