import { command } from "ccstate";

import { eventConsumerPayload$ } from "../../lib/event-consumer/route";
import { getDatasetName, ingestRequiredToAxiom } from "../external/axiom";

const AGENT_RUN_EVENTS_DATASET = "agent-run-events";

export const ingestAxiomEvents$ = command(
  async ({ get }, signal: AbortSignal) => {
    const payload = get(eventConsumerPayload$);
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

    const ingested = await ingestRequiredToAxiom(
      getDatasetName(AGENT_RUN_EVENTS_DATASET),
      axiomEvents,
    );
    signal.throwIfAborted();
    if (!ingested) {
      return {
        status: 503 as const,
        body: {
          error: "Axiom agent-run-events dataset is not configured",
        },
      };
    }

    return {
      status: 200 as const,
      body: { received: payload.events.length },
    };
  },
);
