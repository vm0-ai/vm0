import { command, computed, state } from "ccstate";
import { awaitRealtimeReady$, setAblyLoop$ } from "./realtime.ts";

const internalReloadChatThreads$ = state(0);

/**
 * Read-only view of the reload counter. Consumers subscribe to this to
 * re-run their computeds whenever the counter bumps.
 */
export const reloadChatThreadsCounter$ = computed((get) => {
  return get(internalReloadChatThreads$);
});

/**
 * Bump the sidebar thread-list reload counter. Triggers `chatThreads$`
 * to refetch on the next read.
 */
export const reloadChatThreads$ = command(({ set }) => {
  set(internalReloadChatThreads$, (n) => {
    return n + 1;
  });
});

/**
 * Subscribe to the user-level `threadListChanged` topic and trigger a
 * sidebar reload on every signal. Server publishes this on any mutation
 * that alters the thread list shape (create, delete, new message, run
 * create/update, title update, mark-read).
 *
 * Loop command returns false so it keeps listening until the signal aborts.
 * Isolated in its own file to avoid an import cycle when `route.ts` wires
 * this into the per-page setup wrapper.
 */
export const subscribeThreadListChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(awaitRealtimeReady$, signal);
    signal.throwIfAborted();
    const onChanged$ = command(({ set }) => {
      set(reloadChatThreads$);
      return false;
    });
    await set(setAblyLoop$, "threadListChanged", onChanged$, signal);
  },
);
