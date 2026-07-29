import { command, computed, state } from "ccstate";
import { setAblyLoop$ } from "./realtime.ts";

const internalReloadChatUnreadState$ = state(0);
const internalReloadChatActiveRunIds$ = state(0);

export const reloadChatUnreadStateCounter$ = computed((get) => {
  return get(internalReloadChatUnreadState$);
});

export const reloadChatActiveRunIdsCounter$ = computed((get) => {
  return get(internalReloadChatActiveRunIds$);
});

export const reloadChatUnreadState$ = command(({ set }) => {
  set(internalReloadChatUnreadState$, (n) => {
    return n + 1;
  });
});

const reloadChatActiveRunIds$ = command(({ set }) => {
  set(internalReloadChatActiveRunIds$, (n) => {
    return n + 1;
  });
});

/**
 * Subscribe to the user-level `threadListChanged` topic and invalidate active
 * run and unread snapshots. Event-sourced thread data has its own incremental
 * subscription.
 *
 * Loop command returns false so it keeps listening until the signal aborts.
 * Isolated in its own file to avoid an import cycle when `route.ts` wires
 * this into the per-page setup wrapper.
 */
export const subscribeThreadListChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadChatActiveRunIds$);
      set(reloadChatUnreadState$);
      return false;
    });
    await set(
      setAblyLoop$,
      { topic: "threadListChanged", loopCommand$: onChanged$ },
      signal,
    );
  },
);

export const subscribeChatThreadReadCursorUpdated$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadChatUnreadState$);
      return false;
    });
    await set(
      setAblyLoop$,
      { topic: "chatThreadReadCursorUpdated", loopCommand$: onChanged$ },
      signal,
    );
  },
);
