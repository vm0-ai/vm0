import { cronMonitorChatMessageQueueContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { monitorChatMessageQueue$ } from "../services/cron-monitor-chat-message-queue.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const monitorChatMessageQueueRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const body = await set(monitorChatMessageQueue$, signal);
    signal.throwIfAborted();
    return { status: 200 as const, body };
  },
);

export const cronMonitorChatMessageQueueRoutes: readonly RouteEntry[] = [
  {
    route: cronMonitorChatMessageQueueContract.monitor,
    handler: monitorChatMessageQueueRoute$,
  },
];
