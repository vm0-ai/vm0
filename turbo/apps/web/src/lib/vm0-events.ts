/**
 * VM0 Events Service
 * Helper functions for sending VM0 system events
 */

import { agentRunEvents } from "../db/schema/agent-run-event";
import { max } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type {
  Vm0StartEvent,
  Vm0ResultEvent,
  Vm0ErrorEvent,
} from "../types/vm0-events";

/**
 * Send a VM0 start event
 */
export async function sendVm0StartEvent(
  params: Omit<Vm0StartEvent, "type" | "timestamp">,
): Promise<void> {
  const event: Vm0StartEvent = {
    type: "vm0_start",
    timestamp: new Date().toISOString(),
    ...params,
  };

  await sendVm0Event(params.runId, event);
}

/**
 * Send a VM0 result event
 */
export async function sendVm0ResultEvent(
  params: Omit<Vm0ResultEvent, "type" | "status" | "timestamp">,
): Promise<void> {
  const event: Vm0ResultEvent = {
    type: "vm0_result",
    status: "completed",
    timestamp: new Date().toISOString(),
    ...params,
  };

  await sendVm0Event(params.runId, event);
}

/**
 * Send a VM0 error event
 */
export async function sendVm0ErrorEvent(
  params: Omit<Vm0ErrorEvent, "type" | "status" | "timestamp">,
): Promise<void> {
  const event: Vm0ErrorEvent = {
    type: "vm0_error",
    status: "failed",
    timestamp: new Date().toISOString(),
    ...params,
  };

  await sendVm0Event(params.runId, event);
}

/**
 * Internal function to send a VM0 event to the database
 */
async function sendVm0Event(
  runId: string,
  event: Vm0StartEvent | Vm0ResultEvent | Vm0ErrorEvent,
): Promise<void> {
  // Get the last sequence number for this run
  const [lastEvent] = await globalThis.services.db
    .select({ maxSeq: max(agentRunEvents.sequenceNumber) })
    .from(agentRunEvents)
    .where(eq(agentRunEvents.runId, runId));

  const lastSequence = lastEvent?.maxSeq ?? 0;
  const nextSequence = lastSequence + 1;

  // Insert the event
  await globalThis.services.db.insert(agentRunEvents).values({
    runId,
    sequenceNumber: nextSequence,
    eventType: event.type,
    eventData: event,
  });

  console.log(`[VM0 Events] Sent ${event.type} event for run ${runId}`);
}
