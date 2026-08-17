import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { logger } from "../../lib/log";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const AXIOM_EVENT_INGEST_TIMEOUT_MS = 10_000;
const AXIOM_EVENT_DATA_MAX_BYTES = 900_000;

const L = logger("agent-event-consumer:axiom");

function serializedUtf8Bytes(value: Record<string, unknown>): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Axiom event data must be JSON serializable");
  }
  return new TextEncoder().encode(serialized).byteLength;
}

function eventDataForAxiom(runId: string, event: AgentEvent): AgentEvent {
  const originalBytes = serializedUtf8Bytes(event);
  if (originalBytes <= AXIOM_EVENT_DATA_MAX_BYTES) {
    return event;
  }

  const reducedEvent = {
    type: event.type,
    sequenceNumber: event.sequenceNumber,
    vm0AxiomReduction: {
      reason: "field_size_limit",
      originalBytes,
      budgetBytes: AXIOM_EVENT_DATA_MAX_BYTES,
    },
  };
  const deliveredBytes = serializedUtf8Bytes(reducedEvent);
  L.warn("Reduced oversized agent event for Axiom", {
    runId,
    sequenceNumber: event.sequenceNumber,
    eventType: event.type,
    originalBytes,
    deliveredBytes,
    budgetBytes: AXIOM_EVENT_DATA_MAX_BYTES,
  });
  return reducedEvent;
}

export async function ingestAxiomEvents(
  payload: EventConsumerPayload,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const axiomEvents = payload.events.map((event) => {
    return {
      runId: payload.runId,
      userId: payload.context.userId,
      sequenceNumber: event.sequenceNumber,
      eventType: event.type,
      eventData: eventDataForAxiom(payload.runId, event),
    };
  });
  const ingestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(AXIOM_EVENT_INGEST_TIMEOUT_MS),
  ]);

  const result = await ingestAxiomDirect(
    getDatasetName(AGENT_RUN_EVENTS_DATASET),
    axiomEvents,
    ingestSignal,
  );
  signal.throwIfAborted();
  if (!result.configured) {
    throw new Error("Axiom agent-run-events dataset is not configured");
  }
}
