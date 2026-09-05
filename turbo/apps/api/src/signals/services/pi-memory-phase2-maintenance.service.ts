import { agentRuns } from "@okouai/db/schema/agent-run";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import {
  PI_MEMORY_PHASE2_MAX_ATTEMPTS,
  piMemoryPhase2Jobs,
} from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { ApiDb, Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import type {
  InternalRunCallbackDispatchResult,
  InternalRunCallbackEnvelope,
} from "./internal-run-callback";
import {
  PI_MEMORY_PHASE2_RETRY_DELAY_MS,
  piMemoryPhase2SelectionDigest,
} from "./pi-memory-phase2-job.service";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const piMemoryPhase2MaintenanceCallbackPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    memoryStorageId: z.uuid(),
    orgId: z.string().min(1),
    userId: z.string().min(1),
    leaseToken: z.uuid(),
    claimedRevision: z.number().int().positive(),
    claimedBaseVersionId: sha256Schema,
    selectionDigest: sha256Schema,
    selected: z
      .array(
        z
          .object({
            piSessionId: z.string().min(1).max(255),
            sourceHistoryHash: sha256Schema,
          })
          .strict(),
      )
      .max(256),
  })
  .strict()
  .readonly();

export type PiMemoryPhase2MaintenanceCallbackPayload = z.infer<
  typeof piMemoryPhase2MaintenanceCallbackPayloadSchema
>;

export interface PiMemoryPhase2MaintenanceRunBinding {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly selectionDigest: string;
}

function exactActiveMaintenanceCondition(args: {
  readonly binding: PiMemoryPhase2MaintenanceRunBinding;
  readonly runId: string;
}) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, args.binding.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, args.binding.orgId),
    eq(piMemoryPhase2Jobs.userId, args.binding.userId),
    eq(piMemoryPhase2Jobs.status, "leased"),
    eq(piMemoryPhase2Jobs.leaseToken, args.binding.leaseToken),
    eq(piMemoryPhase2Jobs.sandboxLeaseToken, args.binding.leaseToken),
    eq(piMemoryPhase2Jobs.claimedRevision, args.binding.claimedRevision),
    eq(
      piMemoryPhase2Jobs.claimedBaseVersionId,
      args.binding.claimedBaseVersionId,
    ),
    eq(piMemoryPhase2Jobs.claimedSelectionDigest, args.binding.selectionDigest),
    eq(piMemoryPhase2Jobs.maintenanceRunId, args.runId),
  );
}

/** Bind the run before its transaction can make a runner job visible. */
export async function bindPiMemoryPhase2MaintenanceRun(
  tx: Tx,
  args: {
    readonly binding: PiMemoryPhase2MaintenanceRunBinding;
    readonly runId: string;
  },
): Promise<void> {
  const [bound] = await tx
    .update(piMemoryPhase2Jobs)
    .set({ maintenanceRunId: args.runId, updatedAt: nowDate() })
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, args.binding.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, args.binding.orgId),
        eq(piMemoryPhase2Jobs.userId, args.binding.userId),
        eq(piMemoryPhase2Jobs.status, "leased"),
        eq(piMemoryPhase2Jobs.leaseToken, args.binding.leaseToken),
        eq(piMemoryPhase2Jobs.sandboxLeaseToken, args.binding.leaseToken),
        eq(piMemoryPhase2Jobs.claimedRevision, args.binding.claimedRevision),
        eq(
          piMemoryPhase2Jobs.claimedBaseVersionId,
          args.binding.claimedBaseVersionId,
        ),
        eq(
          piMemoryPhase2Jobs.claimedSelectionDigest,
          args.binding.selectionDigest,
        ),
        sql`${piMemoryPhase2Jobs.maintenanceRunId} IS NULL`,
        sql`${piMemoryPhase2Jobs.leaseExpiresAt} > ${nowDate()}`,
      ),
    )
    .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
  if (!bound) {
    throw new Error("Pi memory Phase 2 maintenance run lost its claim fence");
  }
}

async function updateSelectionWatermarks(
  tx: Tx,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
): Promise<void> {
  await tx
    .update(piMemoryStage1Candidates)
    .set({ lastSelectedSourceHistoryHash: null })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, payload.memoryStorageId),
        eq(piMemoryStage1Candidates.orgId, payload.orgId),
        eq(piMemoryStage1Candidates.userId, payload.userId),
      ),
    );
  for (const candidate of payload.selected) {
    await tx
      .update(piMemoryStage1Candidates)
      .set({ lastSelectedSourceHistoryHash: candidate.sourceHistoryHash })
      .where(
        and(
          eq(piMemoryStage1Candidates.memoryStorageId, payload.memoryStorageId),
          eq(piMemoryStage1Candidates.orgId, payload.orgId),
          eq(piMemoryStage1Candidates.userId, payload.userId),
          eq(piMemoryStage1Candidates.status, "succeeded"),
          eq(piMemoryStage1Candidates.piSessionId, candidate.piSessionId),
          eq(
            piMemoryStage1Candidates.sourceHistoryHash,
            candidate.sourceHistoryHash,
          ),
        ),
      );
  }
}

async function transitionMaintenanceFailure(
  tx: Tx,
  args: {
    readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
    readonly runId: string;
    readonly errorClass: string;
    readonly inputRevision: number;
    readonly retryCount: number;
  },
): Promise<void> {
  const hasNewerInput = args.inputRevision > args.payload.claimedRevision;
  const retryCount = hasNewerInput
    ? 0
    : Math.min(PI_MEMORY_PHASE2_MAX_ATTEMPTS, args.retryCount + 1);
  const terminal = retryCount >= PI_MEMORY_PHASE2_MAX_ATTEMPTS;
  const [failed] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: hasNewerInput
        ? "pending"
        : terminal
          ? "terminal_failure"
          : "retryable_failure",
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      legacyLeaseToken: null,
      sandboxLeaseToken: null,
      leaseExpiresAt: null,
      maintenanceRunId: null,
      retryCount,
      retryAt:
        hasNewerInput || terminal
          ? null
          : new Date(nowDate().getTime() + PI_MEMORY_PHASE2_RETRY_DELAY_MS),
      lastErrorClass: hasNewerInput ? null : args.errorClass,
      claimedSelectionDigest: null,
      claimedSelectedCount: null,
      claimedSelectedUtf8Bytes: null,
      lastMaintenanceRunId: args.runId,
      lastMaintenanceRevision: args.payload.claimedRevision,
      lastMaintenanceBaseVersionId: args.payload.claimedBaseVersionId,
      lastMaintenanceSelectionDigest: args.payload.selectionDigest,
      lastMaintenanceCheckpointId: null,
      lastMaintenanceCheckpointVersionId: null,
      lastMaintenanceOutcome: "failed",
      updatedAt: nowDate(),
    })
    .where(
      exactActiveMaintenanceCondition({
        binding: args.payload,
        runId: args.runId,
      }),
    )
    .returning({ id: piMemoryPhase2Jobs.memoryStorageId });
  if (!failed) {
    throw new Error("Pi memory maintenance failure lost its exact run fence");
  }
}

function callbackErrorClass(
  run:
    | Readonly<{
        status: typeof agentRuns.$inferSelect.status;
        failureReason: string | null;
      }>
    | undefined,
): string {
  if (run?.status === "cancelled") {
    return "maintenance_run_cancelled";
  }
  if (run?.failureReason) {
    return `maintenance_${run.failureReason}`;
  }
  return "maintenance_run_failed";
}

interface ExactMaintenanceCheckpoint {
  readonly id: string;
  readonly versionId: string;
}

async function findExactMaintenanceCheckpoint(
  tx: Tx,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
  runId: string,
): Promise<ExactMaintenanceCheckpoint | undefined> {
  const [checkpoint] = await tx
    .select({
      id: checkpoints.id,
      storageMounts: checkpoints.storageMounts,
    })
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .limit(1);
  const memoryMount = checkpoint?.storageMounts?.find((mount) => {
    return (
      mount.storageId === payload.memoryStorageId &&
      mount.name === "memory" &&
      mount.writeback === true
    );
  });
  const versionId = memoryMount?.version;
  if (!checkpoint || !versionId) {
    return undefined;
  }
  if (versionId === payload.claimedBaseVersionId) {
    return { id: checkpoint.id, versionId };
  }

  const [lineage] = await tx
    .select({ id: storageVersionLineage.id })
    .from(storageVersionLineage)
    .where(
      and(
        eq(storageVersionLineage.storageId, payload.memoryStorageId),
        eq(storageVersionLineage.versionId, versionId),
        eq(storageVersionLineage.parentVersionId, payload.claimedBaseVersionId),
        eq(storageVersionLineage.runId, runId),
      ),
    )
    .limit(1);
  return lineage ? { id: checkpoint.id, versionId } : undefined;
}

async function completeMaintenanceSuccess(
  tx: Tx,
  args: {
    readonly payload: PiMemoryPhase2MaintenanceCallbackPayload;
    readonly runId: string;
    readonly checkpoint: ExactMaintenanceCheckpoint;
  },
): Promise<void> {
  await updateSelectionWatermarks(tx, args.payload);
  const published =
    args.checkpoint.versionId !== args.payload.claimedBaseVersionId;
  const completedAt = nowDate();
  const [completed] = await tx
    .update(piMemoryPhase2Jobs)
    .set({
      status: sql`CASE
        WHEN ${piMemoryPhase2Jobs.inputRevision} = ${args.payload.claimedRevision}
        THEN 'idle'
        ELSE 'pending'
      END`,
      completedRevision: args.payload.claimedRevision,
      claimedRevision: null,
      claimedBaseVersionId: null,
      leaseToken: null,
      legacyLeaseToken: null,
      sandboxLeaseToken: null,
      leaseExpiresAt: null,
      maintenanceRunId: null,
      retryCount: 0,
      retryAt: null,
      lastErrorClass: null,
      lastSucceededAt: completedAt,
      claimedSelectionDigest: null,
      claimedSelectedCount: null,
      claimedSelectedUtf8Bytes: null,
      lastObservedHeadVersionId: args.checkpoint.versionId,
      ...(published
        ? {
            lastPublishedVersionId: args.checkpoint.versionId,
            lastPublishedAt: completedAt,
          }
        : {}),
      lastMaintenanceRunId: args.runId,
      lastMaintenanceRevision: args.payload.claimedRevision,
      lastMaintenanceBaseVersionId: args.payload.claimedBaseVersionId,
      lastMaintenanceSelectionDigest: args.payload.selectionDigest,
      lastMaintenanceCheckpointId: args.checkpoint.id,
      lastMaintenanceCheckpointVersionId: args.checkpoint.versionId,
      lastMaintenanceOutcome: published ? "published" : "no_diff",
      updatedAt: completedAt,
    })
    .where(
      exactActiveMaintenanceCondition({
        binding: args.payload,
        runId: args.runId,
      }),
    )
    .returning({ id: piMemoryPhase2Jobs.memoryStorageId });
  if (!completed) {
    throw new Error(
      "Pi memory maintenance completion lost its exact run fence",
    );
  }
}

async function observeTerminalMaintenance(
  tx: Tx,
  envelope: InternalRunCallbackEnvelope,
  payload: PiMemoryPhase2MaintenanceCallbackPayload,
): Promise<InternalRunCallbackDispatchResult> {
  const [job] = await tx
    .select({
      inputRevision: piMemoryPhase2Jobs.inputRevision,
      retryCount: piMemoryPhase2Jobs.retryCount,
      lastMaintenanceRunId: piMemoryPhase2Jobs.lastMaintenanceRunId,
    })
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, payload.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, payload.orgId),
        eq(piMemoryPhase2Jobs.userId, payload.userId),
      ),
    )
    .limit(1)
    .for("update", { of: piMemoryPhase2Jobs });
  if (!job || job.lastMaintenanceRunId === envelope.runId) {
    return { success: true, skipped: true };
  }

  const [run] = await tx
    .select({
      status: agentRuns.status,
      failureReason: agentRuns.failureReason,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, envelope.runId),
        eq(agentRuns.orgId, payload.orgId),
        eq(agentRuns.userId, payload.userId),
      ),
    )
    .limit(1);
  const activeCondition = exactActiveMaintenanceCondition({
    binding: payload,
    runId: envelope.runId,
  });
  const [active] = await tx
    .select({ id: piMemoryPhase2Jobs.memoryStorageId })
    .from(piMemoryPhase2Jobs)
    .where(activeCondition)
    .limit(1);
  if (!active) {
    return { success: true, skipped: true };
  }

  if (envelope.status !== "completed" || run?.status !== "completed") {
    await transitionMaintenanceFailure(tx, {
      payload,
      runId: envelope.runId,
      errorClass: callbackErrorClass(run),
      inputRevision: job.inputRevision,
      retryCount: job.retryCount,
    });
    return { success: true };
  }

  const checkpoint = await findExactMaintenanceCheckpoint(
    tx,
    payload,
    envelope.runId,
  );
  if (!checkpoint) {
    await transitionMaintenanceFailure(tx, {
      payload,
      runId: envelope.runId,
      errorClass: "maintenance_checkpoint_invalid",
      inputRevision: job.inputRevision,
      retryCount: job.retryCount,
    });
    return { success: true };
  }

  await completeMaintenanceSuccess(tx, {
    payload,
    runId: envelope.runId,
    checkpoint,
  });
  return { success: true };
}

/** Observe an exact terminal run/checkpoint; never writes Storage state. */
export async function handlePiMemoryPhase2MaintenanceCallback(
  db: ApiDb,
  envelope: InternalRunCallbackEnvelope,
): Promise<InternalRunCallbackDispatchResult> {
  if (envelope.status === "progress") {
    return { success: true, skipped: true };
  }
  const parsed = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    envelope.payload,
  );
  if (!parsed.success) {
    return { success: false, error: "Invalid Pi memory maintenance callback" };
  }
  const payload = parsed.data;
  if (
    piMemoryPhase2SelectionDigest(payload.selected) !== payload.selectionDigest
  ) {
    return {
      success: false,
      error: "Pi memory maintenance callback selection mismatch",
    };
  }
  return await db.transaction(async (tx) => {
    return await observeTerminalMaintenance(tx, envelope, payload);
  });
}
