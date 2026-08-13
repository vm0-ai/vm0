import { cronSnapshotChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { snapshotChatEvents$ } from "../services/cron-snapshot-chat-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const snapshotChatEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(snapshotChatEvents$, { kind: "global" }, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronSnapshotChatEventsRoutes: readonly RouteEntry[] = [
  {
    route: cronSnapshotChatEventsContract.snapshot,
    handler: snapshotChatEventsRoute$,
  },
];
