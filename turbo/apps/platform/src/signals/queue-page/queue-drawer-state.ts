import { command, computed, state } from "ccstate";
import { searchParams$, replaceSearchParams$ } from "../route.ts";
import { startQueuePolling$ } from "./queue-signals.ts";
import { resetSignal } from "../utils.ts";
import { maybePageSignal$ } from "../page-signal.ts";
import { rootSignal$ } from "../root-signal.ts";

const internalQueueDrawerOpen$ = state(false);
const resetQueuePollingSignal$ = resetSignal();

export const queueDrawerOpen$ = computed((get) => {
  return get(internalQueueDrawerOpen$);
});

export const setQueueDrawerOpen$ = command(
  async ({ get, set }, open: boolean, _signal: AbortSignal) => {
    set(internalQueueDrawerOpen$, open);
    const pageSignal = get(maybePageSignal$);

    const params = get(searchParams$);
    const next = new URLSearchParams(params);

    if (open) {
      if (!next.has("queue")) {
        next.set("queue", "1");
        set(replaceSearchParams$, next);
      }
      const signal = pageSignal
        ? set(resetQueuePollingSignal$, pageSignal)
        : set(resetQueuePollingSignal$);
      await set(startQueuePolling$, signal);
    } else {
      if (next.has("queue")) {
        next.delete("queue");
        set(replaceSearchParams$, next);
      }
      set(resetQueuePollingSignal$);
    }
  },
);

export const openQueueDrawer$ = command(({ get, set }) => {
  set(setQueueDrawerOpen$, true, get(rootSignal$).signal);
});
