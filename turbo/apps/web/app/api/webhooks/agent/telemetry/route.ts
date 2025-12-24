import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookTelemetryContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/logger";
import {
  createSecretMasker,
  decryptSecrets,
} from "../../../../../src/lib/crypto";
import {
  ingestToAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../src/lib/axiom";

const log = logger("webhooks:telemetry");

const router = tsr.router(webhookTelemetryContract, {
  send: async ({ body }) => {
    const startTime = Date.now();
    log.debug(`[telemetry] START runId=${body.runId}`);

    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const authStart = Date.now();
    const auth = await getSandboxAuthForRun(body.runId);
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

    // Verify run exists and belongs to user, and fetch secrets for masking
    const selectStart = Date.now();
    const [run] = await globalThis.services.db
      .select({ id: agentRuns.id, secrets: agentRuns.secrets })
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

    // Get secrets from run record and create masker for protecting sensitive data
    let secretValues: string[] = [];
    if (run.secrets && typeof run.secrets === "object") {
      const encryptedSecrets = run.secrets as Record<string, string>;
      const decrypted = decryptSecrets(encryptedSecrets);
      secretValues = Object.values(decrypted);
    }
    const masker = createSecretMasker(secretValues);

    // Ingest system log to Axiom (fire-and-forget - don't fail webhook if Axiom fails)
    if (body.systemLog) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_SYSTEM);
      const axiomEvent = {
        _time: new Date().toISOString(),
        runId: body.runId,
        userId: auth.userId,
        log: masker.mask(body.systemLog) as string,
      };
      ingestToAxiom(axiomDataset, [axiomEvent]).catch((err) => {
        log.error("Axiom system log ingest failed:", err);
      });
    }

    // Ingest metrics to Axiom (fire-and-forget)
    if (body.metrics && body.metrics.length > 0) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_METRICS);
      const axiomEvents = body.metrics.map((metric) => ({
        _time: metric.ts,
        runId: body.runId,
        userId: auth.userId,
        cpu: metric.cpu,
        mem_used: metric.mem_used,
        mem_total: metric.mem_total,
        disk_used: metric.disk_used,
        disk_total: metric.disk_total,
      }));
      ingestToAxiom(axiomDataset, axiomEvents).catch((err) => {
        log.error("Axiom metrics ingest failed:", err);
      });
    }

    // Ingest network logs to Axiom (fire-and-forget)
    if (body.networkLogs && body.networkLogs.length > 0) {
      const axiomDataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
      const maskedNetworkLogs = masker.mask(
        body.networkLogs,
      ) as typeof body.networkLogs;
      const axiomEvents = maskedNetworkLogs.map((netLog) => ({
        _time: netLog.timestamp,
        runId: body.runId,
        userId: auth.userId,
        method: netLog.method,
        url: netLog.url,
        status: netLog.status,
        latency_ms: netLog.latency_ms,
        request_size: netLog.request_size,
        response_size: netLog.response_size,
      }));
      ingestToAxiom(axiomDataset, axiomEvents).catch((err) => {
        log.error("Axiom network logs ingest failed:", err);
      });
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

const handler = createNextHandler(webhookTelemetryContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
