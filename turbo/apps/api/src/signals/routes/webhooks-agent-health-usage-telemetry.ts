import { command } from "ccstate";
import {
  webhookHeartbeatContract,
  webhookModelUsageObservationContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";
import {
  isSupportedRunModel,
  normalizeRunModelId,
} from "@vm0/api-contracts/contracts/model-providers";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { RouteEntry } from "../route";
import { dispatchProgressCallbacks$ } from "../services/agent-run-callbacks.service";
import { settle } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const SANDBOX_TELEMETRY_SYSTEM_DATASET = "sandbox-telemetry-system";
const SANDBOX_TELEMETRY_METRICS_DATASET = "sandbox-telemetry-metrics";
const SANDBOX_TELEMETRY_NETWORK_DATASET = "sandbox-telemetry-network";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const MODEL_USAGE_KIND = "model";

const L = logger("webhooks:agent");

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
  const hasModelEvents = body.events.some((event) => {
    return event.kind === MODEL_USAGE_KIND;
  });
  const [runModelContext] = hasModelEvents
    ? await db
        .select({
          modelProvider: zeroRuns.modelProvider,
        })
        .from(zeroRuns)
        .where(eq(zeroRuns.id, body.runId))
        .limit(1)
    : [];
  signal.throwIfAborted();

  const modelProviderType = runModelContext?.modelProvider ?? null;
  const usageEventValues = body.events
    .filter((event) => {
      return (
        event.kind !== MODEL_USAGE_KIND ||
        modelProviderType === null ||
        modelProviderType === "vm0"
      );
    })
    .map((event) => {
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
    });
  const insertResult = await settle(
    (async () => {
      if (usageEventValues.length > 0) {
        await db
          .insert(usageEvent)
          .values(usageEventValues)
          .onConflictDoNothing({ target: [usageEvent.idempotencyKey] });
      }
    })(),
  );
  signal.throwIfAborted();
  if (!insertResult.ok) {
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

const modelUsageObservationBody$ = bodyResultOf(
  webhookModelUsageObservationContract.send,
);
const modelUsageObservation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(modelUsageObservationBody$);
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
    const [runModelContext] = await db
      .select({
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, body.runId))
      .limit(1);
    signal.throwIfAborted();

    const modelProviderType = runModelContext?.modelProvider ?? "";
    const selectedModel = runModelContext?.selectedModel ?? null;
    const observedAt = nowDate();
    const observationValues = body.events.flatMap((event) => {
      const canonicalModel = normalizeRunModelId(selectedModel ?? event.model);
      if (!isSupportedRunModel(canonicalModel)) {
        return [];
      }
      return [
        {
          runId: body.runId,
          orgId: auth.orgId,
          userId: auth.userId,
          model: canonicalModel,
          modelProviderType,
          category: event.category,
          quantity: event.quantity,
          observedAt,
          idempotencyKey: event.idempotencyKey,
        },
      ];
    });
    const insertResult = await settle(
      (async () => {
        if (observationValues.length > 0) {
          await db
            .insert(modelUsageObservation)
            .values(observationValues)
            .onConflictDoNothing({
              target: [modelUsageObservation.idempotencyKey],
            });
        }
      })(),
    );
    signal.throwIfAborted();
    if (!insertResult.ok) {
      if (isForeignKeyViolation(insertResult.error)) {
        L.debug("Run not found for model usage observation, dropping", {
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
  },
);

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

  let telemetryBuffered = false;

  if (body.systemLog) {
    telemetryBuffered =
      ingestToAxiom(getDatasetName(SANDBOX_TELEMETRY_SYSTEM_DATASET), [
        {
          _time: nowDate().toISOString(),
          runId: body.runId,
          userId: auth.userId,
          log: body.systemLog,
        },
      ]) || telemetryBuffered;
  }

  if (body.metrics && body.metrics.length > 0) {
    telemetryBuffered =
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
      ) || telemetryBuffered;
  }

  if (body.networkLogs && body.networkLogs.length > 0) {
    telemetryBuffered =
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
      ) || telemetryBuffered;
  }

  if (telemetryBuffered) {
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
    route: webhookModelUsageObservationContract.send,
    handler: modelUsageObservation$,
  },
  {
    route: webhookTelemetryContract.send,
    handler: telemetry$,
  },
];
