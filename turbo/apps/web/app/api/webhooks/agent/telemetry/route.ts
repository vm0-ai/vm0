import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookTelemetryContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../src/db/schema/sandbox-telemetry";
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
      const axiomStart = Date.now();
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
      log.debug(
        `[telemetry] Axiom ingest queued in ${Date.now() - axiomStart}ms`,
      );
    }

    // Store metrics and network logs in PostgreSQL (system logs now go to Axiom)
    const hasMetrics = body.metrics && body.metrics.length > 0;
    const hasNetworkLogs = body.networkLogs && body.networkLogs.length > 0;

    let insertedId: string | undefined;
    if (hasMetrics || hasNetworkLogs) {
      const insertStart = Date.now();
      const result = await globalThis.services.db
        .insert(sandboxTelemetry)
        .values({
          runId: body.runId,
          data: {
            metrics: body.metrics ?? [],
            networkLogs: masker.mask(body.networkLogs ?? []),
          },
        })
        .returning({ id: sandboxTelemetry.id });
      log.debug(`[telemetry] INSERT took ${Date.now() - insertStart}ms`);
      insertedId = result[0]?.id;
    }

    log.debug(
      `[telemetry] DONE runId=${body.runId} total=${Date.now() - startTime}ms systemLog=${body.systemLog?.length ?? 0}B`,
    );

    return {
      status: 200 as const,
      body: {
        success: true,
        id: insertedId ?? body.runId,
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
