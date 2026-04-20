import { state, computed, command } from "ccstate";
import { writeToClipboard } from "./clipboard.ts";

// ---------------------------------------------------------------------------
// Copy message state
// ---------------------------------------------------------------------------

const copiedMessageId$ = state<string | null>(null);

const copiedMessageTimerId$ = state<number | null>(null);

export const copiedMessageIdValue$ = computed((get) => {
  return get(copiedMessageId$);
});

export const copyMessageContent$ = command(
  async (
    { get, set },
    messageId: string,
    content: string,
    signal: AbortSignal,
  ) => {
    const ok = await writeToClipboard(content);
    signal.throwIfAborted();
    if (!ok) {
      return;
    }

    const existingTimerId = get(copiedMessageTimerId$);
    if (existingTimerId !== null) {
      window.clearTimeout(existingTimerId);
    }

    set(copiedMessageId$, messageId);
    const timerId = window.setTimeout(() => {
      set(copiedMessageId$, null);
      set(copiedMessageTimerId$, null);
    }, 2000);
    set(copiedMessageTimerId$, timerId);
  },
);
