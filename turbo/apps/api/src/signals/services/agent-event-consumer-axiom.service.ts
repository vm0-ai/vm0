import type { EventConsumerPayload } from "../../lib/event-consumer/verify";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const AXIOM_EVENT_INGEST_TIMEOUT_MS = 10_000;

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
      eventData: event,
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
