import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import {
  ingestToAxiom,
  flushAxiom,
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
  const ingested = ingestToAxiom(axiomDataset, axiomEvents);
  if (!ingested) {
    return NextResponse.json(
      { error: "Axiom agent-run-events dataset is not configured" },
      { status: 503 },
    );
  }
  // Flush explicitly: this route uses NextResponse (not ts-rest-handler), so
  // flushAxiom() is not called automatically at the response boundary.
  // Without this, the SDK buffer is never flushed during this serverless
  // function's lifetime, and the CLI sees no events when polling Axiom.
  try {
    await flushAxiom({ throwOnError: true, client: "sessions" });
  } catch {
    return NextResponse.json(
      { error: "Axiom agent-run-events flush failed" },
      { status: 503 },
    );
  }

  return NextResponse.json({ received: events.length });
}
