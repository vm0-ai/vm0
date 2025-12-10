import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../src/db/schema/sandbox-telemetry";
import { eq, and } from "drizzle-orm";
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
import { logger } from "../../../../../src/lib/logger";

/** Logger instance for telemetry webhook */
const log = logger("webhooks:telemetry");

/**
 * Metric data point from sandbox
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
 * Request body for telemetry webhook endpoint
 */
interface TelemetryRequest {
  runId: string;
  systemLog?: string;
  metrics?: MetricData[];
}

/**
 * Response from telemetry endpoint
 */
interface TelemetryResponse {
  success: boolean;
  id: string;
}

/**
 * POST /api/webhooks/agent/telemetry
 * Receive telemetry data (system log and metrics) from sandbox
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const body: TelemetryRequest = await request.json();

    if (!body.runId) {
      throw new BadRequestError("Missing runId");
    }

    // Verify run exists and belongs to user
    const [run] = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    // Store telemetry data
    const result = await globalThis.services.db
      .insert(sandboxTelemetry)
      .values({
        runId: body.runId,
        data: {
          systemLog: body.systemLog ?? "",
          metrics: body.metrics ?? [],
        },
      })
      .returning({ id: sandboxTelemetry.id });

    const inserted = result[0];
    if (!inserted) {
      throw new Error("Failed to insert telemetry record");
    }

    log.debug(
      `Stored telemetry for run ${body.runId}: systemLog=${body.systemLog?.length ?? 0} bytes, metrics=${body.metrics?.length ?? 0} entries`,
    );

    const response: TelemetryResponse = {
      success: true,
      id: inserted.id,
    };
    return successResponse(response, 200);
  } catch (error) {
    log.error("Telemetry error:", error);
    return errorResponse(error);
  }
}
