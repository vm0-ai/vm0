/**
 * VM0 Events Service
 * Helper functions for sending VM0 system events
 */

import { agentRunEvents } from "../db/schema/agent-run-event";
import { sql } from "drizzle-orm";
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
 * Uses atomic subquery to get next sequence number without race conditions
 */
async function sendVm0Event(
  runId: string,
  event: Vm0StartEvent | Vm0ResultEvent | Vm0ErrorEvent,
): Promise<void> {
  // Use a subquery to get next sequence number atomically
  // This avoids race conditions and extra queries
  await globalThis.services.db.insert(agentRunEvents).values({
    runId,
    sequenceNumber: sql`(
      SELECT COALESCE(MAX(sequence_number), 0) + 1
      FROM agent_run_events
      WHERE run_id = ${runId}
    )`,
    eventType: event.type,
    eventData: event,
  });

  console.log(`[VM0 Events] Sent ${event.type} event for run ${runId}`);
}
