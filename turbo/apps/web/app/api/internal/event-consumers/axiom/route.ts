import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import {
  ingestToAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/shared/axiom";

/**
 * POST /api/internal/event-consumers/axiom
 *
 * Ingests agent events into the Axiom dataset.
 * Receives ALL event types (no filter in registry).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyEventConsumer(request);
  if (!result.ok) {
    return result.response;
  }

  const { runId, events, context } = result.data;

  const axiomEvents = events.map((event) => {
    return {
      runId,
      userId: context.userId,
      sequenceNumber: event.sequenceNumber,
      eventType: event.type,
      eventData: event,
    };
  });

  const axiomDataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  ingestToAxiom(axiomDataset, axiomEvents);

  return NextResponse.json({ received: events.length });
}
