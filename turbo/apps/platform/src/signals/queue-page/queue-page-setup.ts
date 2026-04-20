import { command } from "ccstate";
import { logger } from "../log.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { openQueueDrawer$ } from "./queue-drawer-state.ts";
import { startQueuePolling$ } from "./queue-signals.ts";

const L = logger("QueuePage");

/**
 * When navigating to /queues, redirect to home and open the queue drawer.
 * Queue polling is started so the drawer has fresh data.
 */
export const setupQueuePage$ = command(({ set }, signal: AbortSignal) => {
  // Open drawer and redirect to home
  set(openQueueDrawer$);
  set(detachedNavigateTo$, "/");

  // Start polling so the drawer gets data
  set(startQueuePolling$, signal).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      return;
    }
    L.error("Queue polling failed", error);
  });
});
