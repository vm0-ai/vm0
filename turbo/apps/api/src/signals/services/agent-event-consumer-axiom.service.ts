import type {
  AgentEvent,
  EventConsumerPayload,
} from "../../lib/event-consumer/verify";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const AXIOM_EVENT_INGEST_TIMEOUT_MS = 10_000;
const LEGACY_PI_MESSAGE_COMPLETED_EVENT_TYPE = "pi.message.completed";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function eventDataForTelemetry(
  event: AgentEvent,
): AgentEvent | Record<string, unknown> {
  if (event.type !== LEGACY_PI_MESSAGE_COMPLETED_EVENT_TYPE) {
    return event;
  }

  // In-flight senders can outlive the transcript endpoint rollback. Preserve
  // useful coordinates without sending the canonical model transcript.
  const message = recordOf(event.message);
  return {
    type: event.type,
    sequenceNumber: event.sequenceNumber,
    messageId: event.messageId,
    expectedVersion: event.expectedVersion,
    expectedLastOrdinal: event.expectedLastOrdinal,
    role: message?.role,
    payloadBytes:
      message === null
        ? undefined
        : Buffer.byteLength(JSON.stringify(message), "utf8"),
  };
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
      eventData: eventDataForTelemetry(event),
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
