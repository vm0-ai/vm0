import { cronSnapshotChatEventsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import {
  snapshotChatEvents$,
  verifyChatEventSnapshotConvergence$,
} from "../services/cron-snapshot-chat-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const snapshotChatEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(snapshotChatEvents$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

const verifyChatEventSnapshotConvergenceRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const convergence = await set(verifyChatEventSnapshotConvergence$, signal);
    signal.throwIfAborted();
    if (convergence.nonV4SnapshotHeads > 0) {
      return {
        status: 409 as const,
        body: {
          error: {
            code: "CHAT_EVENT_SNAPSHOT_V4_CONVERGENCE_INCOMPLETE" as const,
            message: `${convergence.nonV4SnapshotHeads.toString()} snapshot heads are not on archive schema v4`,
          },
          convergence,
        },
      };
    }
    return {
      status: 200 as const,
      body: { success: true as const, ...convergence },
    };
  },
);

export const cronSnapshotChatEventsRoutes: readonly RouteEntry[] = [
  {
    route: cronSnapshotChatEventsContract.snapshot,
    handler: snapshotChatEventsRoute$,
  },
  {
    route: cronSnapshotChatEventsContract.verifyConvergence,
    handler: verifyChatEventSnapshotConvergenceRoute$,
  },
];
