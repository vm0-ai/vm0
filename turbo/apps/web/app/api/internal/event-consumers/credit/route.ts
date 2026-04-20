import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyEventConsumer } from "../../../../../src/lib/infra/event-consumer";
import { upsertCreditUsage } from "../../../../../src/lib/zero/credit/credit-usage-service";

/**
 * POST /api/internal/event-consumers/credit
 *
 * Upserts client credit usage from agent events.
 * Receives ALL event types (no filter in registry).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyEventConsumer(request);
  if (!result.ok) {
    return result.response;
  }

  const { runId, events, context } = result.data;

  await upsertCreditUsage(
    runId,
    context.orgId,
    context.userId,
    events,
    context.modelProvider,
    context.selectedModel,
  );

  return NextResponse.json({ received: events.length });
}
