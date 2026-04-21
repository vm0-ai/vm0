import { state, computed, command, type Computed, type Command } from "ccstate";
import { delay } from "signal-timers";
import type { PagedChatMessage } from "@vm0/core";
import type { GroupedChatMessageGroup } from "./chat-message.ts";

// ---------------------------------------------------------------------------
// Block colors — shuffled once per factory call
// ---------------------------------------------------------------------------

const BLOCK_COLORS = [
  "#e8a0b4",
  "#c4705a",
  "#f5b88a",
  "#a8b560",
  "#6bb5a0",
  "#7baed4",
  "#b09eda",
  "#d4a87b",
  "#e07878",
  "#82c4c2",
] as const;

function shuffleBlockColors(): [string, string, string] {
  const shuffled = [...BLOCK_COLORS].sort(() => {
    return Math.random() - 0.5;
  });
  return [shuffled[0]!, shuffled[1]!, shuffled[2]!];
}

// ---------------------------------------------------------------------------
// Rotating phrase — cycles through thinking phrases on a delay loop
// ---------------------------------------------------------------------------

const THINKING_PHRASES = [
  "Brewing...",
  "Piecing together...",
  "Spinning up...",
  "On it...",
  "Assembling...",
  "Sketching out...",
  "Mapping it...",
  "Wiring up...",
  "Shaping...",
  "Tuning in...",
] as const;

const PHRASE_INTERVAL_MS = 3500;

// ---------------------------------------------------------------------------
// Done phrase — cached per message ID so it stays stable across re-renders
// ---------------------------------------------------------------------------

const DONE_PHRASES = [
  (t: string) => {
    return `Wrapped up at ${t}`;
  },
  (t: string) => {
    return `All done \u2014 ${t}`;
  },
  (t: string) => {
    return `Delivered at ${t}`;
  },
  (t: string) => {
    return `Finished at ${t}, at your service`;
  },
  (t: string) => {
    return `That was a wrap \u2014 ${t}`;
  },
  (t: string) => {
    return `Mission complete, ${t}`;
  },
  (t: string) => {
    return `Signed off at ${t}`;
  },
  (t: string) => {
    return `Done and dusted \u2014 ${t}`;
  },
] as const;

function formatDonePhrase(lastMsg: PagedChatMessage | undefined): string {
  const time = lastMsg
    ? new Date(lastMsg.createdAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "just now";
  const pick = DONE_PHRASES[Math.floor(Math.random() * DONE_PHRASES.length)]!;
  return pick(time);
}

// ---------------------------------------------------------------------------
// Per-indicator signals factory
// ---------------------------------------------------------------------------

export interface ThinkingIndicatorSignals {
  blockColors$: Computed<[string, string, string]>;
  rotatingPhrase$: Computed<string>;
  donePhrase$: Computed<string>;
  /**
   * Long-running command that rotates the thinking phrase while the run is
   * active. Aborts cleanly when the page signal fires. Should be called from
   * the page setup command.
   */
  runPhraseLoop$: Command<Promise<void>, [AbortSignal]>;
}

export function createThinkingIndicatorSignals(
  allFinished$: Computed<Promise<boolean>>,
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>,
): ThinkingIndicatorSignals {
  // Block colors — set once at creation, never changes
  const internalBlockColors$ =
    state<[string, string, string]>(shuffleBlockColors());
  const blockColors$ = computed((get) => {
    return get(internalBlockColors$);
  });

  // Rotating phrase state
  const phraseIndex$ = state(
    Math.floor(Math.random() * THINKING_PHRASES.length),
  );

  const rotatingPhrase$ = computed((get) => {
    const index = get(phraseIndex$);
    return THINKING_PHRASES[index]!;
  });

  // Done phrase — updated by runPhraseLoop$ when the last message changes
  const internalDonePhrase$ = state<string>(formatDonePhrase(undefined));
  const donePhrase$ = computed((get) => {
    return get(internalDonePhrase$);
  });
  const lastDoneMessageId$ = state<string | undefined>(undefined);

  const runPhraseLoop$ = command(async ({ get, set }, signal: AbortSignal) => {
    while (!signal.aborted) {
      const groups = await get(groupedChatMessages$);
      signal.throwIfAborted();

      // Update done phrase when message changes
      const lastGroup = groups[groups.length - 1];
      const lastIsAssistant = lastGroup?.role === "assistant";
      const lastMsg =
        lastIsAssistant && lastGroup
          ? lastGroup.messages[lastGroup.messages.length - 1]
          : undefined;
      const prevId = get(lastDoneMessageId$);
      if (lastMsg?.id !== prevId) {
        set(lastDoneMessageId$, lastMsg?.id);
        set(internalDonePhrase$, formatDonePhrase(lastMsg));
      }

      // Derive running state
      const allFinished = await get(allFinished$);
      signal.throwIfAborted();
      const waitingForAssistant = !!lastGroup && !lastIsAssistant;
      const running = !allFinished || waitingForAssistant;

      if (running) {
        await delay(PHRASE_INTERVAL_MS, { signal });
        const current = get(phraseIndex$);
        set(phraseIndex$, (current + 1) % THINKING_PHRASES.length);
      } else {
        // When not running, sleep longer before checking again
        await delay(PHRASE_INTERVAL_MS, { signal });
      }
    }
  });

  return {
    blockColors$,
    rotatingPhrase$,
    donePhrase$,
    runPhraseLoop$,
  };
}
