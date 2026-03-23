import { state, computed, command } from "ccstate";
import { onRef } from "../utils.ts";

// ---------------------------------------------------------------------------
// Thinking message cycling (RunActivityLine)
// ---------------------------------------------------------------------------

const THINKING_MESSAGES = [
  "On it, grab a coffee",
  "Thinking hard...",
  "Cooking up something good...",
  "Give me a sec...",
  "Working my magic...",
  "Hang tight...",
  "Let me figure this out...",
  "Brewing ideas...",
  "Crunching the numbers...",
  "Just a moment...",
] as const;

const INITIAL_THINKING_INDEX = Math.floor(
  Math.random() * THINKING_MESSAGES.length,
);

const thinkingIndex$ = state(INITIAL_THINKING_INDEX);

export const thinkingMessage$ = computed(
  (get) => THINKING_MESSAGES[get(thinkingIndex$)]!,
);

const cycleThinkingCmd$ = command(
  ({ set }, _el: HTMLDivElement, signal: AbortSignal) => {
    const id = window.setInterval(() => {
      set(thinkingIndex$, (prev) => (prev + 1) % THINKING_MESSAGES.length);
    }, 3000);
    signal.addEventListener("abort", () => {
      window.clearInterval(id);
    });
  },
);

export const cycleThinkingRef$ = onRef(cycleThinkingCmd$);

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
