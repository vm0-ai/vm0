import { command } from "ccstate";
import {
  webhookHeartbeatContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { and, eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { isSandboxToken, verifySandboxToken } from "../auth/tokens";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { RouteEntry } from "../route";
import { dispatchProgressCallbacks$ } from "../services/agent-run-callbacks.service";
import { safeAsync } from "../utils";

const SANDBOX_TELEMETRY_SYSTEM_DATASET = "sandbox-telemetry-system";
const SANDBOX_TELEMETRY_METRICS_DATASET = "sandbox-telemetry-metrics";
const SANDBOX_TELEMETRY_NETWORK_DATASET = "sandbox-telemetry-network";
const PG_FOREIGN_KEY_VIOLATION = "23503";

const L = logger("webhooks:agent");

const unauthorizedRunMismatch = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated or runId mismatch",
      code: "UNAUTHORIZED",
    }),
  }),
});

function getSandboxAuthForRun(
  expectedRunId: string,
  authHeader: string | undefined,
): SandboxAuth | null {
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.substring("Bearer ".length);
  if (!isSandboxToken(token)) {
    return null;
  }

  const auth = verifySandboxToken(token);
  if (!auth || auth.runId !== expectedRunId) {
    return null;
  }

  return auth;
}

function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const { cause } = error;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }

  return cause.code === PG_FOREIGN_KEY_VIOLATION;
}

const heartbeatBody$ = bodyResultOf(webhookHeartbeatContract.send);
const heartbeat$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  const db = set(writeDb$);
  const result = await db
    .update(agentRuns)
    .set({ lastHeartbeatAt: nowDate() })
    .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, auth.userId)))
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();

  if (result.length === 0) {
    return notFound("Agent run not found");
  }

  waitUntil(set(dispatchProgressCallbacks$, body.runId, signal));

  return {
    status: 200 as const,
    body: { ok: true },
  };
});

const usageEventBody$ = bodyResultOf(webhookUsageEventContract.send);
const usageEvent$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(usageEventBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  const db = set(writeDb$);
  const insertResult = await safeAsync(() => {
    return db
      .insert(usageEvent)
      .values(
        body.events.map((event) => {
          return {
            runId: body.runId,
            orgId: auth.orgId,
            userId: auth.userId,
            kind: event.kind,
            provider: event.provider,
            category: event.category,
            quantity: event.quantity,
            idempotencyKey: event.idempotencyKey,
          };
        }),
      )
      .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
  });
  signal.throwIfAborted();
  if ("error" in insertResult) {
    if (isForeignKeyViolation(insertResult.error)) {
      L.debug("Run not found for usage event, dropping", {
        runId: body.runId,
        eventCount: body.events.length,
      });
      return notFound("Run not found");
    }
    throw insertResult.error;
  }

  return {
    status: 200 as const,
    body: { success: true },
  };
});

const telemetryBody$ = bodyResultOf(webhookTelemetryContract.send);
const telemetry$ = command(async ({ get }, signal: AbortSignal) => {
  const bodyResult = await get(telemetryBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  const db = get(db$);
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, auth.userId)))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return notFound("Agent run not found");
  }

  if (body.systemLog) {
    ingestToAxiom(getDatasetName(SANDBOX_TELEMETRY_SYSTEM_DATASET), [
      {
        _time: nowDate().toISOString(),
        runId: body.runId,
        userId: auth.userId,
        log: body.systemLog,
      },
    ]);
  }

  if (body.metrics && body.metrics.length > 0) {
    ingestToAxiom(
      getDatasetName(SANDBOX_TELEMETRY_METRICS_DATASET),
      body.metrics.map((metric) => {
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
      }),
    );
  }

  if (body.networkLogs && body.networkLogs.length > 0) {
    ingestToAxiom(
      getDatasetName(SANDBOX_TELEMETRY_NETWORK_DATASET),
      body.networkLogs.map(({ timestamp, ...rest }) => {
        return {
          ...rest,
          _time: timestamp,
          runId: body.runId,
          userId: auth.userId,
        };
      }),
    );
    await flushAxiom({ client: "telemetry", throwOnError: true });
    signal.throwIfAborted();
  }

  if (body.sandboxOperations && body.sandboxOperations.length > 0) {
    for (const op of body.sandboxOperations) {
      recordSandboxOperation({
        actionType: op.action_type,
        sandboxType: "runner",
        durationMs: op.duration_ms,
        success: op.success,
        runId: body.runId,
        dimensions: {
          source: "sandbox",
          ...(op.error ? { error: op.error } : {}),
        },
      });
    }
  }

  return {
    status: 200 as const,
    body: {
      success: true,
      id: body.runId,
    },
  };
});

export const webhooksAgentHealthUsageTelemetryRoutes: readonly RouteEntry[] = [
  {
    route: webhookHeartbeatContract.send,
    handler: heartbeat$,
  },
  {
    route: webhookUsageEventContract.send,
    handler: usageEvent$,
  },
  {
    route: webhookTelemetryContract.send,
    handler: telemetry$,
  },
];
