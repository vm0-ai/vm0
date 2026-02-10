import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookTelemetryContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/logger";
import {
  ingestToAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";
import { recordSandboxInternalOperation } from "../../../../../src/lib/metrics";
import { storeTelemetry } from "../../../../../src/lib/telemetry/local-store";

/**
 * Store telemetry data to PostgreSQL when Axiom is not configured.
 */
async function storeTelemetryFallback(body: {
  runId: string;
  systemLog?: string;
  metrics?: Array<{
    ts: string;
    cpu: number;
    mem_used: number;
    mem_total: number;
    disk_used: number;
    disk_total: number;
  }>;
  networkLogs?: Array<Record<string, unknown>>;
}): Promise<void> {
  const hasData =
    body.systemLog || body.metrics?.length || body.networkLogs?.length;
  if (!hasData) return;

  await storeTelemetry(body.runId, {
    systemLog: body.systemLog,
    metrics: body.metrics,
    networkLogs: body.networkLogs as Array<{
      timestamp: string;
      mode?: "mitm" | "sni";
      action?: "ALLOW" | "DENY";
      host?: string;
      port?: number;
    }>,
  });
}

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
      .select({ id: agentRuns.id, sandboxId: agentRuns.sandboxId })
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

    // Ingest system log to Axiom (fire-and-forget - don't fail webhook if Axiom fails)
    let axiomIngested = false;
    if (body.systemLog) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
      const axiomEvent = {
        _time: new Date().toISOString(),
        runId: body.runId,
        userId: auth.userId,
        log: body.systemLog, // Already masked by client
      };
      axiomIngested = await ingestToAxiom(axiomDataset, [axiomEvent]).catch(
        (err) => {
          log.error("Axiom system log ingest failed:", err);
          return false;
        },
      );
    }

    // Ingest metrics to Axiom (fire-and-forget)
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
        }) => ({
          _time: metric.ts,
          runId: body.runId,
          userId: auth.userId,
          cpu: metric.cpu,
          mem_used: metric.mem_used,
          mem_total: metric.mem_total,
          disk_used: metric.disk_used,
          disk_total: metric.disk_total,
        }),
      );
      ingestToAxiom(axiomDataset, axiomEvents).catch((err) => {
        log.error("Axiom metrics ingest failed:", err);
      });
    }

    // Ingest network logs to Axiom (fire-and-forget)
    // Supports both SNI-only mode (basic connection info) and MITM mode (full HTTP details)
    if (body.networkLogs && body.networkLogs.length > 0) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
      // Network logs are already masked by client
      const axiomEvents = body.networkLogs.map(
        (netLog: Record<string, unknown>) => ({
          _time: netLog.timestamp,
          runId: body.runId,
          userId: auth.userId,
          // Common fields (all modes)
          mode: netLog.mode,
          action: netLog.action,
          host: netLog.host,
          port: netLog.port,
          rule_matched: netLog.rule_matched,
          // MITM-only fields (may be undefined for SNI-only mode)
          method: netLog.method,
          url: netLog.url,
          status: netLog.status,
          latency_ms: netLog.latency_ms,
          request_size: netLog.request_size,
          response_size: netLog.response_size,
        }),
      );
      ingestToAxiom(axiomDataset, axiomEvents).catch((err) => {
        log.error("Axiom network logs ingest failed:", err);
      });
    }

    // DB fallback: store telemetry locally when Axiom is not configured
    if (!axiomIngested) {
      storeTelemetryFallback(body).catch((err: unknown) => {
        log.error("DB telemetry store failed:", err);
      });
    }

    // Record sandbox internal operations as OpenTelemetry metrics (to sandbox-metric-{env} dataset)
    if (body.sandboxOperations && body.sandboxOperations.length > 0) {
      // Determine sandbox type: E2B sets sandboxId, Runner does not
      const sandboxType = run.sandboxId ? "e2b" : "runner";

      for (const op of body.sandboxOperations) {
        recordSandboxInternalOperation({
          actionType: op.action_type,
          sandboxType,
          durationMs: op.duration_ms,
          success: op.success,
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
  errorHandler,
});

export { handler as POST };
