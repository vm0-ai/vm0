import { command, computed, state, type Computed } from "ccstate";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import { setChatThreadPinned$ } from "./chat-event.ts";

export function createChatThreadPinSignals(
  threadId: string,
  meta$: Computed<ThreadMeta | null>,
) {
  const lastMutation$ = state<Promise<void> | null>(null);
  const pinned$ = computed((get) => {
    const pinnedAt = get(meta$)?.pinnedAt;
    return pinnedAt !== null && pinnedAt !== undefined;
  });
  return {
    pinned$,
    setPinned$: command(
      async ({ get, set }, pinned: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (get(pinned$) === pinned) {
          return;
        }
        const mutation = set(
          setChatThreadPinned$,
          { threadId, pinned, after: get(lastMutation$) },
          signal,
        );
        set(lastMutation$, mutation);
        await mutation;
      },
    ),
  };
}

export type ChatThreadPinSignals = ReturnType<
  typeof createChatThreadPinSignals
>;
