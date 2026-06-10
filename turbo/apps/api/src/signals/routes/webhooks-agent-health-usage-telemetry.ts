import { command } from "ccstate";
import type { z } from "zod";
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
import { now, nowDate } from "../../lib/time";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  SANDBOX_OP_LOG_DATASET,
  sandboxOperationAxiomEvent,
} from "../external/sandbox-op-log";
import type { RouteEntry } from "../route";
import { dispatchProgressCallbacks$ } from "../services/agent-run-callbacks.service";
import { settle, tapError } from "../utils";
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

type TelemetryDatasetFamily =
  | "system"
  | "metrics"
  | "network"
  | "sandbox_operations";

interface TelemetryPayloadSummary {
  readonly runId: string;
  readonly hasSystemLog: boolean;
  readonly hasMetrics: boolean;
  readonly hasNetworkLogs: boolean;
  readonly hasSandboxOperations: boolean;
  readonly metricsCount: number;
  readonly networkLogCount: number;
  readonly sandboxOperationCount: number;
  readonly sandboxOperationErrorCount: number;
  readonly approxPayloadBytes: number;
  readonly approxPayloadSizeBucket: string;
}

type TelemetryBody = z.infer<typeof webhookTelemetryContract.send.body>;

interface TelemetryIngestResult {
  readonly telemetryBuffered: boolean;
  readonly axiomDatasetFamilies: readonly TelemetryDatasetFamily[];
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

function estimateTelemetryPayloadBytes(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (typeof value === "number") {
    return value.toString().length;
  }
  if (typeof value === "boolean") {
    return value ? 4 : 5;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => {
      return total + estimateTelemetryPayloadBytes(item);
    }, 2);
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.keys(record).reduce((total, key) => {
      return total + key.length + estimateTelemetryPayloadBytes(record[key]);
    }, 2);
  }
  return 0;
}

function payloadSizeBucket(bytes: number): string {
  if (bytes < 1024) {
    return "lt_1kb";
  }
  if (bytes < 10 * 1024) {
    return "1kb_10kb";
  }
  if (bytes < 100 * 1024) {
    return "10kb_100kb";
  }
  if (bytes < 1024 * 1024) {
    return "100kb_1mb";
  }
  return "gte_1mb";
}

function summarizeTelemetryPayload(body: {
  readonly runId: string;
  readonly systemLog?: string;
  readonly metrics?: readonly unknown[];
  readonly networkLogs?: readonly unknown[];
  readonly sandboxOperations?: readonly {
    readonly error?: string;
  }[];
}): TelemetryPayloadSummary {
  const metricsCount = body.metrics?.length ?? 0;
  const networkLogCount = body.networkLogs?.length ?? 0;
  const sandboxOperationCount = body.sandboxOperations?.length ?? 0;
  const approxPayloadBytes = estimateTelemetryPayloadBytes(body);

  return {
    runId: body.runId,
    hasSystemLog: Boolean(body.systemLog),
    hasMetrics: metricsCount > 0,
    hasNetworkLogs: networkLogCount > 0,
    hasSandboxOperations: sandboxOperationCount > 0,
    metricsCount,
    networkLogCount,
    sandboxOperationCount,
    sandboxOperationErrorCount:
      body.sandboxOperations?.filter((operation) => {
        return operation.error !== undefined;
      }).length ?? 0,
    approxPayloadBytes,
    approxPayloadSizeBucket: payloadSizeBucket(approxPayloadBytes),
  };
}

function ingestTelemetryRows(args: {
  readonly dataset: string;
  readonly family: TelemetryDatasetFamily;
  readonly events: readonly Record<string, unknown>[];
  readonly summary: TelemetryPayloadSummary;
}): boolean {
  const buffered = ingestToAxiom(args.dataset, args.events);
  if (!buffered) {
    L.warn("Agent telemetry Axiom ingest skipped", {
      ...args.summary,
      axiomDatasetFamily: args.family,
      axiomFailureCategory: "ingest_skipped",
    });
  }
  return buffered;
}

function systemTelemetryEvents(
  body: TelemetryBody,
  userId: string,
): readonly Record<string, unknown>[] {
  return [
    {
      _time: nowDate().toISOString(),
      runId: body.runId,
      userId,
      log: body.systemLog,
    },
  ];
}

function metricTelemetryEvents(
  body: TelemetryBody,
  userId: string,
): readonly Record<string, unknown>[] {
  return (
    body.metrics?.map((metric) => {
      return {
        _time: metric.ts,
        runId: body.runId,
        userId,
        cpu: metric.cpu,
        mem_used: metric.mem_used,
        mem_total: metric.mem_total,
        disk_used: metric.disk_used,
        disk_total: metric.disk_total,
      };
    }) ?? []
  );
}

function networkTelemetryEvents(
  body: TelemetryBody,
  userId: string,
): readonly Record<string, unknown>[] {
  return (
    body.networkLogs?.map(({ timestamp, ...rest }) => {
      return {
        ...rest,
        _time: timestamp,
        runId: body.runId,
        userId,
      };
    }) ?? []
  );
}

function sandboxOperationTelemetryEvents(
  body: TelemetryBody,
): readonly Record<string, unknown>[] {
  return (
    body.sandboxOperations?.map((op) => {
      return sandboxOperationAxiomEvent({
        actionType: op.action_type,
        sandboxType: "runner",
        durationMs: op.duration_ms,
        success: op.success,
        runId: body.runId,
        timestamp: op.ts,
        dimensions: {
          source: "sandbox",
          ...(op.error ? { error: op.error } : {}),
        },
      });
    }) ?? []
  );
}

function ingestTelemetryPayload(args: {
  readonly body: TelemetryBody;
  readonly userId: string;
  readonly summary: TelemetryPayloadSummary;
}): TelemetryIngestResult {
  const axiomDatasetFamilies: TelemetryDatasetFamily[] = [];
  let telemetryBuffered = false;
  const recordIngest = (
    family: TelemetryDatasetFamily,
    dataset: string,
    events: readonly Record<string, unknown>[],
  ): void => {
    const buffered = ingestTelemetryRows({
      dataset,
      family,
      events,
      summary: args.summary,
    });
    telemetryBuffered = buffered || telemetryBuffered;
    if (buffered) {
      axiomDatasetFamilies.push(family);
    }
  };

  if (args.body.systemLog) {
    recordIngest(
      "system",
      getDatasetName(SANDBOX_TELEMETRY_SYSTEM_DATASET),
      systemTelemetryEvents(args.body, args.userId),
    );
  }
  if (args.body.metrics && args.body.metrics.length > 0) {
    recordIngest(
      "metrics",
      getDatasetName(SANDBOX_TELEMETRY_METRICS_DATASET),
      metricTelemetryEvents(args.body, args.userId),
    );
  }
  if (args.body.networkLogs && args.body.networkLogs.length > 0) {
    recordIngest(
      "network",
      getDatasetName(SANDBOX_TELEMETRY_NETWORK_DATASET),
      networkTelemetryEvents(args.body, args.userId),
    );
  }
  if (args.body.sandboxOperations && args.body.sandboxOperations.length > 0) {
    recordIngest(
      "sandbox_operations",
      getDatasetName(SANDBOX_OP_LOG_DATASET),
      sandboxOperationTelemetryEvents(args.body),
    );
  }

  return { telemetryBuffered, axiomDatasetFamilies };
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

  const telemetrySummary = summarizeTelemetryPayload(body);
  const { telemetryBuffered, axiomDatasetFamilies } = ingestTelemetryPayload({
    body,
    userId: auth.userId,
    summary: telemetrySummary,
  });

  if (telemetryBuffered) {
    const axiomStartedAt = now();
    waitUntil(
      tapError(
        flushAxiom({ client: "telemetry", throwOnError: true }),
        (error) => {
          L.warn("Agent telemetry Axiom flush failed", {
            ...telemetrySummary,
            axiomDatasetFamilies,
            axiomFailureCategory: "flush",
            axiomLatencyMs: now() - axiomStartedAt,
            error,
          });
        },
      ),
    );
  }

  L.debug("Agent telemetry ingested", {
    ...telemetrySummary,
    axiomDatasetFamilies,
    axiomFlushQueued: telemetryBuffered,
    telemetryBuffered,
  });

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
