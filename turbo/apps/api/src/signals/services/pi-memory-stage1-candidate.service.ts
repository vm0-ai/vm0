import { and, eq, gt, sql } from "drizzle-orm";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { blobs } from "@okouai/db/schema/blob";
import { conversations } from "@okouai/db/schema/conversation";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

export type PiMemoryStage1AdmissionSkipReason =
  | "generation_disabled"
  | "history_not_hash_backed"
  | "missing_chat_thread"
  | "not_completed"
  | "not_pi"
  | "source_not_web"
  | "stale_source";

export type PiMemoryStage1Admission =
  | {
      readonly outcome: "created" | "exact_retry" | "replaced";
      readonly memoryStorageId: string;
      readonly piSessionId: string;
      readonly sourceHistoryHash: string;
    }
  | {
      readonly outcome: "skipped";
      readonly reason: PiMemoryStage1AdmissionSkipReason;
      readonly memoryStorageId?: string;
      readonly piSessionId?: string;
      readonly sourceHistoryHash?: string;
    };

export interface AdmitPiMemoryStage1CandidateArgs {
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly status: "completed" | "failed";
  readonly framework: "claude-code" | "codex" | "pi" | null;
  readonly generationEnabled: boolean;
  readonly triggerSource: string | null;
  readonly chatThreadId: string | null;
  readonly completedAt: Date;
  readonly idleDelayMs: number;
}

export function getPiMemoryStage1AdmissionPrerequisiteSkipReason(
  args: AdmitPiMemoryStage1CandidateArgs,
): PiMemoryStage1AdmissionSkipReason | null {
  if (args.status !== "completed") {
    return "not_completed";
  }
  if (args.framework !== "pi") {
    return "not_pi";
  }
  if (!args.generationEnabled) {
    return "generation_disabled";
  }
  if (args.triggerSource !== "web") {
    return "source_not_web";
  }
  if (args.chatThreadId === null) {
    return "missing_chat_thread";
  }
  return null;
}

async function resolveMemoryStorageId(
  tx: Tx,
  args: Pick<AdmitPiMemoryStage1CandidateArgs, "orgId" | "userId">,
): Promise<string> {
  const [existing] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .limit(1);
  if (existing) {
    return existing.id;
  }

  const location = newStorageS3Location(args.orgId);
  const [created] = await tx
    .insert(storages)
    .values({
      id: location.storageId,
      orgId: args.orgId,
      userId: args.userId,
      name: MEMORY_ARTIFACT_NAME,
      s3Prefix: location.s3Prefix,
    })
    .onConflictDoNothing()
    .returning({ id: storages.id });
  if (created) {
    return created.id;
  }

  const [winner] = await tx
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
        eq(storages.name, MEMORY_ARTIFACT_NAME),
      ),
    )
    .limit(1);
  if (!winner) {
    throw new Error("Memory Storage create race produced no canonical row");
  }
  return winner.id;
}

export async function admitPiMemoryStage1Candidate(
  tx: Tx,
  args: AdmitPiMemoryStage1CandidateArgs,
): Promise<PiMemoryStage1Admission> {
  const prerequisiteSkipReason =
    getPiMemoryStage1AdmissionPrerequisiteSkipReason(args);
  if (prerequisiteSkipReason !== null) {
    return { outcome: "skipped", reason: prerequisiteSkipReason };
  }

  const [source] = await tx
    .select({
      piSessionId: conversations.cliAgentSessionId,
      sourceHistoryHash: conversations.cliAgentSessionHistoryHash,
    })
    .from(conversations)
    .innerJoin(blobs, eq(conversations.cliAgentSessionHistoryHash, blobs.hash))
    .where(
      and(
        eq(conversations.runId, args.runId),
        eq(conversations.cliAgentType, "pi"),
      ),
    )
    .limit(1);
  if (!source?.sourceHistoryHash) {
    return { outcome: "skipped", reason: "history_not_hash_backed" };
  }

  const memoryStorageId = await resolveMemoryStorageId(tx, args);
  const eligibleAt = new Date(args.completedAt.getTime() + args.idleDelayMs);
  const [created] = await tx
    .insert(piMemoryStage1Candidates)
    .values({
      memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      piSessionId: source.piSessionId,
      sourceRunId: args.runId,
      sourceHistoryHash: source.sourceHistoryHash,
      sourceCompletedAt: args.completedAt,
      eligibleAt,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId });
  if (created) {
    return {
      outcome: "created",
      memoryStorageId,
      piSessionId: source.piSessionId,
      sourceHistoryHash: source.sourceHistoryHash,
    };
  }

  const [current] = await tx
    .select({
      sourceCompletedAt: piMemoryStage1Candidates.sourceCompletedAt,
      sourceHistoryHash: piMemoryStage1Candidates.sourceHistoryHash,
    })
    .from(piMemoryStage1Candidates)
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, source.piSessionId),
      ),
    )
    .for("update", { of: piMemoryStage1Candidates })
    .limit(1);
  if (!current) {
    throw new Error("Pi memory candidate conflict produced no canonical row");
  }
  if (current.sourceHistoryHash === source.sourceHistoryHash) {
    return {
      outcome: "exact_retry",
      memoryStorageId,
      piSessionId: source.piSessionId,
      sourceHistoryHash: source.sourceHistoryHash,
    };
  }
  if (current.sourceCompletedAt >= args.completedAt) {
    return {
      outcome: "skipped",
      reason: "stale_source",
      memoryStorageId,
      piSessionId: source.piSessionId,
      sourceHistoryHash: source.sourceHistoryHash,
    };
  }

  await tx
    .update(piMemoryStage1Candidates)
    .set({
      sourceRunId: args.runId,
      sourceHistoryHash: source.sourceHistoryHash,
      sourceCompletedAt: args.completedAt,
      eligibleAt,
      status: "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      retryAt: null,
      retryCount: 0,
      lastErrorClass: null,
      rawMemory: null,
      rolloutSummary: null,
      rolloutSlug: null,
      generatedAt: null,
      lastSelectedSourceHistoryHash: null,
      usageCount: 0,
      lastUsedAt: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, source.piSessionId),
        eq(
          piMemoryStage1Candidates.sourceHistoryHash,
          current.sourceHistoryHash,
        ),
      ),
    );
  return {
    outcome: "replaced",
    memoryStorageId,
    piSessionId: source.piSessionId,
    sourceHistoryHash: source.sourceHistoryHash,
  };
}

export type PiMemoryStage1CommitResult =
  | {
      readonly kind: "succeeded";
      readonly rawMemory: string;
      readonly rolloutSummary: string;
      readonly rolloutSlug?: string;
    }
  | { readonly kind: "succeeded_no_output" }
  | {
      readonly kind: "retryable_failure";
      readonly retryAt: Date;
      readonly errorClass: string;
    }
  | { readonly kind: "terminal_failure"; readonly errorClass: string };

interface CommitPiMemoryStage1CandidateArgs {
  readonly memoryStorageId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly leaseToken: string;
  readonly committedAt: Date;
  readonly result: PiMemoryStage1CommitResult;
}

export async function commitPiMemoryStage1Candidate(
  tx: Tx,
  args: CommitPiMemoryStage1CandidateArgs,
): Promise<boolean> {
  const common = {
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: args.committedAt,
  };
  const resultValues =
    args.result.kind === "succeeded"
      ? {
          status: args.result.kind,
          rawMemory: args.result.rawMemory,
          rolloutSummary: args.result.rolloutSummary,
          rolloutSlug: args.result.rolloutSlug ?? null,
          generatedAt: args.committedAt,
          lastSelectedSourceHistoryHash: null,
          retryAt: null,
          lastErrorClass: null,
        }
      : args.result.kind === "succeeded_no_output"
        ? {
            status: args.result.kind,
            rawMemory: null,
            rolloutSummary: null,
            rolloutSlug: null,
            generatedAt: args.committedAt,
            lastSelectedSourceHistoryHash: null,
            retryAt: null,
            lastErrorClass: null,
          }
        : args.result.kind === "retryable_failure"
          ? {
              status: args.result.kind,
              rawMemory: null,
              rolloutSummary: null,
              rolloutSlug: null,
              generatedAt: null,
              lastSelectedSourceHistoryHash: null,
              retryAt: args.result.retryAt,
              retryCount: sql`${piMemoryStage1Candidates.retryCount} + 1`,
              lastErrorClass: args.result.errorClass,
            }
          : {
              status: args.result.kind,
              rawMemory: null,
              rolloutSummary: null,
              rolloutSlug: null,
              generatedAt: null,
              lastSelectedSourceHistoryHash: null,
              retryAt: null,
              lastErrorClass: args.result.errorClass,
            };
  const [committed] = await tx
    .update(piMemoryStage1Candidates)
    .set({ ...common, ...resultValues })
    .where(
      and(
        eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
        eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
        eq(piMemoryStage1Candidates.sourceHistoryHash, args.sourceHistoryHash),
        eq(piMemoryStage1Candidates.status, "leased"),
        eq(piMemoryStage1Candidates.leaseToken, args.leaseToken),
        gt(piMemoryStage1Candidates.leaseExpiresAt, args.committedAt),
      ),
    )
    .returning({ memoryStorageId: piMemoryStage1Candidates.memoryStorageId });
  return committed !== undefined;
}
