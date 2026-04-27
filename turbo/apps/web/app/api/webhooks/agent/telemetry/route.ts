import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookTelemetryContract } from "@vm0/api-contracts/contracts/webhooks";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/shared/logger";
import {
  ingestToAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/shared/axiom";
import { recordSandboxInternalOperation } from "../../../../../src/lib/infra/metrics";

const log = logger("webhooks:telemetry");

const router = tsr.router(webhookTelemetryContract, {
  send: async ({ body, headers }) => {
    const startTime = Date.now();
    log.debug(`[telemetry] START runId=${body.runId}`);

    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const authStart = Date.now();
    const auth = getSandboxAuthForRun(body.runId, headers.authorization);
    log.debug(`[telemetry] auth took ${Date.now() - authStart}ms`);

    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId } = auth;

    // Verify run exists and belongs to user
    // Note: secrets are no longer stored in DB - masking is done client-side
    const selectStart = Date.now();
    const [run] = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);
    log.debug(`[telemetry] SELECT took ${Date.now() - selectStart}ms`);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Telemetry data is already masked client-side in the sandbox before sending
    // No server-side masking needed - secrets values are never stored

    // Buffer telemetry for Axiom (all flushed at response boundary)
    if (body.systemLog) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
      const axiomEvent = {
        _time: new Date().toISOString(),
        runId: body.runId,
        userId: auth.userId,
        log: body.systemLog, // Already masked by client
      };
      ingestToAxiom(axiomDataset, [axiomEvent]);
    }

    if (body.metrics && body.metrics.length > 0) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_METRICS);
      const axiomEvents = body.metrics.map(
        (metric: {
          ts: string;
          cpu: number;
          mem_used: number;
          mem_total: number;
          disk_used: number;
          disk_total: number;
        }) => {
          return {
            _time: metric.ts,
            runId: body.runId,
            userId: auth.userId,
            cpu: metric.cpu,
            mem_used: metric.mem_used,
            mem_total: metric.mem_total,
            disk_used: metric.disk_used,
            disk_total: metric.disk_total,
          };
        },
      );
      ingestToAxiom(axiomDataset, axiomEvents);
    }

    if (body.networkLogs && body.networkLogs.length > 0) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
      const axiomEvents = body.networkLogs.map(
        ({ timestamp, ...rest }: Record<string, unknown>) => {
          return {
            ...rest,
            _time: timestamp,
            runId: body.runId,
            userId: auth.userId,
          };
        },
      );
      ingestToAxiom(axiomDataset, axiomEvents);
    }

    // Record sandbox internal operations as OpenTelemetry metrics (to sandbox-metric-{env} dataset)
    if (body.sandboxOperations && body.sandboxOperations.length > 0) {
      for (const op of body.sandboxOperations) {
        recordSandboxInternalOperation({
          actionType: op.action_type,
          sandboxType: "runner",
          durationMs: op.duration_ms,
          success: op.success,
          runId: body.runId,
        });
      }
    }

    log.debug(
      `[telemetry] DONE runId=${body.runId} total=${Date.now() - startTime}ms systemLog=${body.systemLog?.length ?? 0}B`,
    );

    return {
      status: 200 as const,
      body: {
        success: true,
        id: body.runId,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  log.error("Telemetry error:", err);
  return undefined;
}

const handler = createHandler(webhookTelemetryContract, router, {
  routeName: "webhooks.agent.telemetry",
  errorHandler,
});

export { handler as POST };
