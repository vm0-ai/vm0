import { cronSnapshotChatEventsContract } from "@okouai/api-contracts/contracts/cron";
import { trace } from "@opentelemetry/api";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import type { RouteEntry } from "../route-entry";
import { snapshotChatEvents$ } from "../services/cron-snapshot-chat-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const CHAT_EVENT_SNAPSHOT_COMPLETION_DATASET = "web-logs";
const CHAT_EVENT_SNAPSHOT_COMPLETION_CONTEXT = "api:cron:snapshot-chat-events";

interface ChatEventSnapshotCompletionCounters {
  readonly skippedUnreadableHeads: number;
  readonly skippedUndecodableHeads: number;
  readonly skippedIncompleteHeads: number;
  readonly duplicateEventIdConflictThreads: number;
  readonly duplicateEventIdConflicts: number;
  readonly duplicateEventIdsRemapped: number;
  readonly duplicateEventReferencesRemapped: number;
}

export function recordChatEventSnapshotCompleted(
  counters: ChatEventSnapshotCompletionCounters,
): void {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  ingestToAxiom(getDatasetName(CHAT_EVENT_SNAPSHOT_COMPLETION_DATASET), [
    {
      _time: nowDate().toISOString(),
      level: "info",
      message: "Completed chat event snapshot",
      source: "api",
      type: "chat_event_snapshot_completed",
      context: CHAT_EVENT_SNAPSHOT_COMPLETION_CONTEXT,
      ...(traceId ? { trace_id: traceId } : {}),
      skippedUnreadableHeads: counters.skippedUnreadableHeads,
      skippedUndecodableHeads: counters.skippedUndecodableHeads,
      skippedIncompleteHeads: counters.skippedIncompleteHeads,
      duplicateEventIdConflictThreads: counters.duplicateEventIdConflictThreads,
      duplicateEventIdConflicts: counters.duplicateEventIdConflicts,
      duplicateEventIdsRemapped: counters.duplicateEventIdsRemapped,
      duplicateEventReferencesRemapped:
        counters.duplicateEventReferencesRemapped,
    },
  ]);
}

const snapshotChatEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(snapshotChatEvents$, { kind: "global" }, signal);
    signal.throwIfAborted();
    recordChatEventSnapshotCompleted(result);
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
