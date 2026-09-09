import { command, computed, state, type Computed } from "ccstate";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import { withCleanup } from "../utils.ts";
import { pinChatThread$, unpinChatThread$ } from "./chat-event.ts";

export function createChatThreadPinSignals(
  threadId: string,
  meta$: Computed<ThreadMeta | null>,
) {
  const pending$ = state(false);
  const pinned$ = computed((get) => {
    const pinnedAt = get(meta$)?.pinnedAt;
    return pinnedAt !== null && pinnedAt !== undefined;
  });
  return {
    pinned$,
    pending$: computed((get) => {
      return get(pending$);
    }),
    setPinned$: command(
      async ({ get, set }, pinned: boolean, signal: AbortSignal) => {
        signal.throwIfAborted();
        if (get(pending$) || get(pinned$) === pinned) {
          return false;
        }
        set(pending$, true);
        await withCleanup(
          set(pinned ? pinChatThread$ : unpinChatThread$, threadId, signal),
          () => {
            set(pending$, false);
          },
        );
        signal.throwIfAborted();
        return true;
      },
    ),
  };
}

export type ChatThreadPinSignals = ReturnType<
  typeof createChatThreadPinSignals
>;
