import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { sandboxMetrics } from "../../../../../src/db/schema/sandbox-metric";
import { agentRunEvents } from "../../../../../src/db/schema/agent-run-event";
import { eq, and, max } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";

/**
 * Metrics data from sandbox
 */
interface MetricData {
  ts: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

/**
 * Request body for metrics webhook endpoint
 */
interface MetricsWebhookRequest {
  runId: string;
  metrics?: MetricData[];
  errors?: string[];
}

/**
 * Response from metrics endpoint
 */
interface MetricsWebhookResponse {
  received: {
    metrics: number;
    errors: number;
  };
}

/**
 * POST /api/webhooks/agent/metrics
 * Receive batched metrics and errors from E2B sandbox
 * - Stores metrics in sandbox_metrics table
 * - Stores errors as events in agent_run_events table
 */
export async function POST(request: NextRequest) {
  try {
    // Initialize services
    initServices();

    // Authenticate using bearer token
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: MetricsWebhookRequest = await request.json();

    if (!body.runId) {
      throw new BadRequestError("Missing runId");
    }

    const hasMetrics = body.metrics && body.metrics.length > 0;
    const hasErrors = body.errors && body.errors.length > 0;

    if (!hasMetrics && !hasErrors) {
      throw new BadRequestError("No metrics or errors provided");
    }

    console.log(
      `[Metrics Webhook] Received ${body.metrics?.length ?? 0} metrics, ${body.errors?.length ?? 0} errors for run ${body.runId}`,
    );

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    let metricsInserted = 0;
    let errorsInserted = 0;

    // Insert metrics
    if (hasMetrics && body.metrics) {
      const metricsToInsert = body.metrics.map((m) => ({
        runId: body.runId,
        timestamp: new Date(m.ts),
        cpuUsedPct: m.cpu,
        memUsed: m.mem_used,
        memTotal: m.mem_total,
        diskUsed: m.disk_used,
        diskTotal: m.disk_total,
      }));

      await globalThis.services.db
        .insert(sandboxMetrics)
        .values(metricsToInsert);
      metricsInserted = metricsToInsert.length;
    }

    // Insert errors as events
    if (hasErrors && body.errors) {
      // Get the last sequence number for this run
      const [lastEvent] = await globalThis.services.db
        .select({ maxSeq: max(agentRunEvents.sequenceNumber) })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, body.runId));

      const lastSequence = lastEvent?.maxSeq ?? 0;

      const errorsToInsert = body.errors.map((errorLine, index) => ({
        runId: body.runId,
        sequenceNumber: lastSequence + index + 1,
        eventType: "sandbox_error",
        eventData: {
          type: "sandbox_error",
          message: errorLine,
          timestamp: new Date().toISOString(),
        },
      }));

      await globalThis.services.db
        .insert(agentRunEvents)
        .values(errorsToInsert);
      errorsInserted = errorsToInsert.length;
    }

    console.log(
      `[Metrics Webhook] Stored ${metricsInserted} metrics, ${errorsInserted} errors for run ${body.runId}`,
    );

    const response: MetricsWebhookResponse = {
      received: {
        metrics: metricsInserted,
        errors: errorsInserted,
      },
    };

    return successResponse(response, 200);
  } catch (error) {
    console.error("[Metrics Webhook] Error:", error);
    return errorResponse(error);
  }
}
