import { cronMonitorChatEventQueueContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { monitorChatEventQueue$ } from "../services/cron-monitor-chat-event-queue.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const monitorChatEventQueueRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const body = await set(monitorChatEventQueue$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronMonitorChatEventQueueRoutes: readonly RouteEntry[] = [
  {
    route: cronMonitorChatEventQueueContract.monitor,
    handler: monitorChatEventQueueRoute$,
  },
];
