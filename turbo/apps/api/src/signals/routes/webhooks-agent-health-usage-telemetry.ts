import { command } from "ccstate";
import {
  webhookHeartbeatContract,
  webhookModelUsageObservationContract,
  webhookModelUsageObservationV2Contract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  compactModelUsageObservation,
  modelUsageObservation,
  modelUsageObservationLegacyKey,
} from "@vm0/db/schema/model-usage-observation";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import {
  isSupportedRunModel,
  normalizeRunModelId,
} from "@vm0/api-contracts/contracts/model-providers";

import { conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$, writeDb$, type Db } from "../external/db";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import type { RouteEntry } from "../route-entry";
import { dispatchProgressCallbacks$ } from "../services/agent-run-callbacks.service";
import { settle } from "../utils";
import {
  getSandboxAuthForRun,
  resolveSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";
import { usageUnderbillingFields } from "../usage-underbilling";

const SANDBOX_TELEMETRY_SYSTEM_DATASET = "sandbox-telemetry-system";
const SANDBOX_TELEMETRY_METRICS_DATASET = "sandbox-telemetry-metrics";
const SANDBOX_TELEMETRY_NETWORK_DATASET = "sandbox-telemetry-network";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const MODEL_USAGE_KIND = "model";

const L = logger("webhooks:agent");

type CompactModelUsageObservationBody = z.infer<
  (typeof webhookModelUsageObservationV2Contract.send)["body"]
>;
type CompactModelUsageObservationEvent =
  CompactModelUsageObservationBody["events"][number];
type CompactModelUsageMetric = NonNullable<
  CompactModelUsageObservationEvent["inputTokens"]
>;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface SupportedCompactModelUsageObservation {
  readonly event: CompactModelUsageObservationEvent;
  readonly model: string;
}

interface CompactModelUsageLegacyKeyValue {
  readonly idempotencyKey: string;
  readonly observedAt: Date;
}

interface CompactModelUsageObservationValue {
  readonly idempotencyKey: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly observedAt: Date;
}

interface StoredCompactModelUsageObservation {
  readonly idempotencyKey: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

class CompactModelUsageObservationConflictError extends Error {
  constructor() {
    super("Compact model usage observation idempotency key is already in use");
    this.name = "CompactModelUsageObservationConflictError";
  }
}

function acceptedCompactMetricQuantity(
  metric: CompactModelUsageMetric | undefined,
  claimedLegacyKeys: ReadonlySet<string>,
): number {
  if (!metric || !claimedLegacyKeys.has(metric.legacyIdempotencyKey)) {
    return 0;
  }
  return metric.quantity;
}

function supportedCompactModelUsageObservations(
  events: readonly CompactModelUsageObservationEvent[],
  selectedModel: string | null,
): readonly SupportedCompactModelUsageObservation[] {
  return events.flatMap((event) => {
    const model = normalizeRunModelId(selectedModel ?? event.model);
    if (!isSupportedRunModel(model)) {
      return [];
    }
    return [{ event, model }];
  });
}

function compactModelUsageLegacyKeyValues(
  observations: readonly SupportedCompactModelUsageObservation[],
  observedAt: Date,
): CompactModelUsageLegacyKeyValue[] {
  return observations.flatMap(({ event }) => {
    return [
      event.inputTokens,
      event.outputTokens,
      event.cacheReadInputTokens,
      event.cacheCreationInputTokens,
    ].flatMap((metric) => {
      if (!metric) {
        return [];
      }
      return [
        {
          idempotencyKey: metric.legacyIdempotencyKey,
          observedAt,
        },
      ];
    });
  });
}

async function claimCompactModelUsageLegacyKeys(
  tx: DbTransaction,
  values: CompactModelUsageLegacyKeyValue[],
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  if (values.length === 0) {
    return new Set();
  }

  const historicalRows = await tx
    .select({
      idempotencyKey: modelUsageObservation.idempotencyKey,
    })
    .from(modelUsageObservation)
    .where(
      inArray(
        modelUsageObservation.idempotencyKey,
        values.map((value) => {
          return value.idempotencyKey;
        }),
      ),
    );
  signal.throwIfAborted();
  const historicalKeys = new Set(
    historicalRows.map((row) => {
      return row.idempotencyKey;
    }),
  );
  const claimValues = values.filter((value) => {
    return !historicalKeys.has(value.idempotencyKey);
  });
  if (claimValues.length === 0) {
    return new Set();
  }

  const claimedRows = await tx
    .insert(modelUsageObservationLegacyKey)
    .values(claimValues)
    .onConflictDoNothing({
      target: [modelUsageObservationLegacyKey.idempotencyKey],
    })
    .returning({
      idempotencyKey: modelUsageObservationLegacyKey.idempotencyKey,
    });
  signal.throwIfAborted();
  return new Set(
    claimedRows.map((row) => {
      return row.idempotencyKey;
    }),
  );
}

function compactModelUsageObservationValues(
  observations: readonly SupportedCompactModelUsageObservation[],
  claimedLegacyKeys: ReadonlySet<string>,
  observedAt: Date,
): CompactModelUsageObservationValue[] {
  return observations.flatMap(({ event, model }) => {
    const inputTokens = acceptedCompactMetricQuantity(
      event.inputTokens,
      claimedLegacyKeys,
    );
    const outputTokens = acceptedCompactMetricQuantity(
      event.outputTokens,
      claimedLegacyKeys,
    );
    const cacheReadInputTokens = acceptedCompactMetricQuantity(
      event.cacheReadInputTokens,
      claimedLegacyKeys,
    );
    const cacheCreationInputTokens = acceptedCompactMetricQuantity(
      event.cacheCreationInputTokens,
      claimedLegacyKeys,
    );
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadInputTokens === 0 &&
      cacheCreationInputTokens === 0
    ) {
      return [];
    }
    return [
      {
        idempotencyKey: event.idempotencyKey,
        model,
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        observedAt,
      },
    ];
  });
}

async function compactModelUsageObservationsMatchStoredRows(
  tx: DbTransaction,
  values: readonly CompactModelUsageObservationValue[],
  signal: AbortSignal,
): Promise<boolean> {
  const rows: StoredCompactModelUsageObservation[] = await tx
    .select({
      idempotencyKey: compactModelUsageObservation.idempotencyKey,
      model: compactModelUsageObservation.model,
      inputTokens: compactModelUsageObservation.inputTokens,
      outputTokens: compactModelUsageObservation.outputTokens,
      cacheReadInputTokens: compactModelUsageObservation.cacheReadInputTokens,
      cacheCreationInputTokens:
        compactModelUsageObservation.cacheCreationInputTokens,
    })
    .from(compactModelUsageObservation)
    .where(
      inArray(
        compactModelUsageObservation.idempotencyKey,
        values.map((value) => {
          return value.idempotencyKey;
        }),
      ),
    );
  signal.throwIfAborted();
  const rowsByIdempotencyKey = new Map(
    rows.map((row) => {
      return [row.idempotencyKey, row] as const;
    }),
  );
  return values.every((value) => {
    const row = rowsByIdempotencyKey.get(value.idempotencyKey);
    return (
      row?.model === value.model &&
      row.inputTokens === value.inputTokens &&
      row.outputTokens === value.outputTokens &&
      row.cacheReadInputTokens === value.cacheReadInputTokens &&
      row.cacheCreationInputTokens === value.cacheCreationInputTokens
    );
  });
}

async function persistCompactModelUsageObservations(
  db: Db,
  body: CompactModelUsageObservationBody,
  signal: AbortSignal,
): Promise<"accepted" | "run_not_found"> {
  return await db.transaction(async (tx) => {
    const [runModelContext] = await tx
      .select({
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, body.runId))
      .limit(1)
      .for("key share");
    signal.throwIfAborted();
    if (!runModelContext) {
      return "run_not_found" as const;
    }

    const observations = supportedCompactModelUsageObservations(
      body.events,
      runModelContext.selectedModel,
    );
    const observedAt = nowDate();
    const claimedLegacyKeys = await claimCompactModelUsageLegacyKeys(
      tx,
      compactModelUsageLegacyKeyValues(observations, observedAt),
      signal,
    );
    const values = compactModelUsageObservationValues(
      observations,
      claimedLegacyKeys,
      observedAt,
    );
    if (values.length === 0) {
      return "accepted" as const;
    }

    const insertedRows = await tx
      .insert(compactModelUsageObservation)
      .values(values)
      .onConflictDoNothing({
        target: [compactModelUsageObservation.idempotencyKey],
      })
      .returning({
        idempotencyKey: compactModelUsageObservation.idempotencyKey,
      });
    signal.throwIfAborted();
    if (
      insertedRows.length !== values.length &&
      !(await compactModelUsageObservationsMatchStoredRows(tx, values, signal))
    ) {
      throw new CompactModelUsageObservationConflictError();
    }
    return "accepted" as const;
  });
}

interface SandboxOperationDimensionInput {
  readonly error?: string;
  readonly encoding?: string;
  readonly session_history_raw_size_bucket?: string;
  readonly session_history_encoded_size_bucket?: string;
  readonly session_history_compression_ratio_bucket?: string;
  readonly session_history_ref_seen_recently?: string;
  readonly session_history_ref_download_inflight?: string;
  readonly session_history_content_length_state?: string;
  readonly session_history_content_encoding_state?: string;
  readonly session_history_transfer_encoding_state?: string;
  readonly session_history_download_source?: string;
}

function sandboxOperationDimensions(
  op: SandboxOperationDimensionInput,
): Record<string, string> {
  return {
    source: "sandbox",
    ...(op.error ? { error: op.error } : {}),
    ...(op.encoding ? { encoding: op.encoding } : {}),
    ...(op.session_history_raw_size_bucket
      ? {
          session_history_raw_size_bucket: op.session_history_raw_size_bucket,
        }
      : {}),
    ...(op.session_history_encoded_size_bucket
      ? {
          session_history_encoded_size_bucket:
            op.session_history_encoded_size_bucket,
        }
      : {}),
    ...(op.session_history_compression_ratio_bucket
      ? {
          session_history_compression_ratio_bucket:
            op.session_history_compression_ratio_bucket,
        }
      : {}),
    ...(op.session_history_ref_seen_recently
      ? {
          session_history_ref_seen_recently:
            op.session_history_ref_seen_recently,
        }
      : {}),
    ...(op.session_history_ref_download_inflight
      ? {
          session_history_ref_download_inflight:
            op.session_history_ref_download_inflight,
        }
      : {}),
    ...(op.session_history_content_length_state
      ? {
          session_history_content_length_state:
            op.session_history_content_length_state,
        }
      : {}),
    ...(op.session_history_content_encoding_state
      ? {
          session_history_content_encoding_state:
            op.session_history_content_encoding_state,
        }
      : {}),
    ...(op.session_history_transfer_encoding_state
      ? {
          session_history_transfer_encoding_state:
            op.session_history_transfer_encoding_state,
        }
      : {}),
    ...(op.session_history_download_source
      ? { session_history_download_source: op.session_history_download_source }
      : {}),
  };
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
        grossCredits:
          event.kind === MODEL_USAGE_KIND ? event.grossCredits : undefined,
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
      L.error("Run not found for usage event, dropping", {
        ...usageUnderbillingFields("run_not_found", "confirmed"),
        runId: body.runId,
        orgId: auth.orgId,
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

const modelUsageObservationV2Body$ = bodyResultOf(
  webhookModelUsageObservationV2Contract.send,
);
const modelUsageObservationV2$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(modelUsageObservationV2Body$);
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
    const insertResult = await settle(
      persistCompactModelUsageObservations(db, body, signal),
      signal,
    );
    signal.throwIfAborted();
    if (!insertResult.ok) {
      if (
        insertResult.error instanceof CompactModelUsageObservationConflictError
      ) {
        return conflict(insertResult.error.message);
      }
      throw insertResult.error;
    }
    if (insertResult.value === "run_not_found") {
      L.debug("Run not found for compact model usage observation, dropping", {
        runId: body.runId,
        eventCount: body.events.length,
      });
      return notFound("Run not found");
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
  const authResult = resolveSandboxAuthForRun(body.runId, get(authorization$));
  if (!authResult.ok) {
    L.warn("Agent telemetry rejected sandbox auth", {
      authFailureReason: authResult.reason,
    });
    return unauthorizedRunMismatch;
  }
  const { auth } = authResult;

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
        timestamp: op.ts,
        dimensions: sandboxOperationDimensions(op),
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
    route: webhookModelUsageObservationV2Contract.send,
    handler: modelUsageObservationV2$,
  },
  {
    route: webhookTelemetryContract.send,
    handler: telemetry$,
  },
];
