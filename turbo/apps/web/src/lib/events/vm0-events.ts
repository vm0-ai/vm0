/**
 * VM0 Events Service
 * Helper functions for sending VM0 system events
 */

import { agentRunEvents } from "../../db/schema/agent-run-event";
import type { Vm0StartEvent, Vm0ResultEvent, Vm0ErrorEvent } from "./types";
import { logger } from "../logger";

const log = logger("events:vm0");

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
 * Uses fixed sequence numbers to avoid database queries
 */
async function sendVm0Event(
  runId: string,
  event: Vm0StartEvent | Vm0ResultEvent | Vm0ErrorEvent,
): Promise<void> {
  // Use fixed sequence numbers for VM0 events:
  // - vm0_start: 0 (before all agent events which start at 1)
  // - vm0_result/error: 1000000 (after all agent events)
  const VM0_SEQUENCE_MAP = {
    vm0_start: 0,
    vm0_result: 1000000,
    vm0_error: 1000000,
  } as const;

  await globalThis.services.db.insert(agentRunEvents).values({
    runId,
    sequenceNumber: VM0_SEQUENCE_MAP[event.type],
    eventType: event.type,
    eventData: event,
  });

  log.debug(`Sent ${event.type} event for run ${runId}`);
}
