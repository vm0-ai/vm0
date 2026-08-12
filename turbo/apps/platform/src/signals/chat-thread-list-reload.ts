import { command, computed, state } from "ccstate";
import { setAblyLoop$ } from "./realtime.ts";

const internalReloadChatIndicators$ = state(0);

export const reloadChatIndicatorsCounter$ = computed((get) => {
  return get(internalReloadChatIndicators$);
});

export const reloadChatIndicators$ = command(({ set }) => {
  set(internalReloadChatIndicators$, (n) => {
    return n + 1;
  });
});

/**
 * Subscribe to the user-level `threadListChanged` topic and invalidate the
 * indicator snapshot. Event-sourced thread data has its own incremental
 * subscription.
 *
 * Loop command returns false so it keeps listening until the signal aborts.
 * Isolated in its own file to avoid an import cycle when `route.ts` wires
 * this into the per-page setup wrapper.
 */
export const subscribeThreadListChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadChatIndicators$);
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
      set(reloadChatIndicators$);
      return false;
    });
    await set(
      setAblyLoop$,
      { topic: "chatThreadReadCursorUpdated", loopCommand$: onChanged$ },
      signal,
    );
  },
);
