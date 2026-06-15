import { command } from "ccstate";
import { internalEventConsumerAxiomContract } from "@vm0/api-contracts/contracts/internal-event-consumers";

import {
  eventConsumerPayload$,
  eventConsumerRoute,
} from "../../lib/event-consumer/route";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import type { RouteEntry } from "../route";
import { settle } from "../utils";

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

    const ingested = ingestToAxiom(
      getDatasetName(AGENT_RUN_EVENTS_DATASET),
      axiomEvents,
    );
    if (!ingested) {
      return {
        status: 503 as const,
        body: {
          error: "Axiom agent-run-events dataset is not configured",
        },
      };
    }

    const flushed = await settle(
      flushAxiom({ throwOnError: true, client: "sessions" }),
    );
    signal.throwIfAborted();
    if (!flushed.ok) {
      return {
        status: 503 as const,
        body: { error: "Axiom agent-run-events flush failed" },
      };
    }

    return {
      status: 200 as const,
      body: { received: payload.events.length },
    };
  },
);

export const internalEventConsumerAxiomRoutes: readonly RouteEntry[] = [
  {
    route: internalEventConsumerAxiomContract.ingest,
    handler: eventConsumerRoute(ingestAxiomEvents$),
  },
];
