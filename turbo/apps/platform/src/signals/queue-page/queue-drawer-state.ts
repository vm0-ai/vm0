import { command, computed, state } from "ccstate";
import { searchParams$, replaceSearchParams$ } from "../route.ts";
import { startQueuePolling$ } from "./queue-signals.ts";
import { detach, Reason, resetSignal } from "../utils.ts";
import { maybePageSignal$ } from "../page-signal.ts";

const internalQueueDrawerOpen$ = state(false);
const resetQueuePollingSignal$ = resetSignal();

export const queueDrawerOpen$ = computed((get) => {
  return get(internalQueueDrawerOpen$);
});

export const setQueueDrawerOpen$ = command(({ get, set }, open: boolean) => {
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

    // confirmed by ethan@vm0.ai
    // eslint-disable-next-line ccstate/no-detach-in-signals -- polling is a long-running background task, fire-and-forget by design
    detach(set(startQueuePolling$, signal), Reason.Entrance);
  } else {
    if (next.has("queue")) {
      next.delete("queue");
      set(replaceSearchParams$, next);
    }
    set(resetQueuePollingSignal$);
  }
});

export const openQueueDrawer$ = command(({ set }) => {
  set(setQueueDrawerOpen$, true);
});
