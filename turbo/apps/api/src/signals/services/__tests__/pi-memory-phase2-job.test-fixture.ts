import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { onTestFinished } from "vitest";

import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { blobs } from "@okouai/db/schema/blob";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storages } from "@okouai/db/schema/storage";

import { db } from "../../../lib/db";

const fixtureHashes = Symbol("fixtureHashes");

interface Phase2TestScope {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly [fixtureHashes]: Set<string>;
}

export interface Phase2CandidateInput {
  readonly piSessionId: string;
  readonly sourceRunId?: string;
  readonly sourceHistoryHash?: string;
  readonly sourceCompletedAt?: Date;
  readonly status?:
    | "pending"
    | "leased"
    | "succeeded"
    | "succeeded_no_output"
    | "retryable_failure"
    | "terminal_failure";
  readonly rawMemory?: string | null;
  readonly rolloutSummary?: string | null;
  readonly rolloutSlug?: string | null;
  readonly generatedAt?: Date | null;
  readonly leaseToken?: string | null;
  readonly leaseExpiresAt?: Date | null;
  readonly retryAt?: Date | null;
  readonly retryCount?: number;
  readonly lastErrorClass?: string | null;
  readonly usageCount?: number;
  readonly lastUsedAt?: Date | null;
  readonly lastSelectedSourceHistoryHash?: string | null;
}

type Phase2CandidateStatus = Exclude<Phase2CandidateInput["status"], undefined>;

function candidateHash(scope: Phase2TestScope, piSessionId: string): string {
  return createHash("sha256")
    .update(`${scope.memoryStorageId}:${piSessionId}:${randomUUID()}`)
    .digest("hex");
}

async function insertFixtureBlobs(
  scope: Phase2TestScope,
  hashes: readonly string[],
): Promise<void> {
  for (const hash of hashes) {
    scope[fixtureHashes].add(hash);
  }
  if (hashes.length === 0) {
    return;
  }
  await db()
    .insert(blobs)
    .values(
      hashes.map((hash) => {
        return {
          hash,
          rawSize: 1,
          encoding: "identity",
          encodedSize: 1,
          refCount: 1,
        };
      }),
    )
    .onConflictDoNothing();
}

export async function createPhase2TestScope(
  label: string,
): Promise<Phase2TestScope> {
  const scope = {
    memoryStorageId: randomUUID(),
    orgId: `phase2-${label}-org-${randomUUID()}`,
    userId: `phase2-${label}-user-${randomUUID()}`,
  } as Phase2TestScope;
  Object.defineProperty(scope, fixtureHashes, {
    value: new Set<string>(),
    enumerable: false,
  });
  await db()
    .insert(storages)
    .values({
      id: scope.memoryStorageId,
      orgId: scope.orgId,
      userId: scope.userId,
      name: MEMORY_ARTIFACT_NAME,
      s3Prefix: `${scope.orgId}/${scope.memoryStorageId}`,
    });
  onTestFinished(async () => {
    await db().delete(storages).where(eq(storages.id, scope.memoryStorageId));
    const hashes = [...scope[fixtureHashes]];
    if (hashes.length > 0) {
      await db().delete(blobs).where(inArray(blobs.hash, hashes));
    }
  });
  return scope;
}

export async function insertPhase2Candidates(
  scope: Phase2TestScope,
  inputs: readonly Phase2CandidateInput[],
): Promise<readonly string[]> {
  const now = new Date("2026-09-03T04:00:00.000Z");
  const hashes = inputs.map((input) => {
    return input.sourceHistoryHash ?? candidateHash(scope, input.piSessionId);
  });
  await insertFixtureBlobs(scope, hashes);
  await db()
    .insert(piMemoryStage1Candidates)
    .values(
      inputs.map((input, index) => {
        return phase2CandidateRow(scope, input, hashes[index] as string, now);
      }),
    );
  return hashes;
}

function phase2CandidateOutput(
  input: Phase2CandidateInput,
  status: Phase2CandidateStatus,
  sourceCompletedAt: Date,
) {
  if (status === "succeeded") {
    return {
      rawMemory: input.rawMemory ?? "raw memory",
      rolloutSummary: input.rolloutSummary ?? "rollout summary",
      rolloutSlug: input.rolloutSlug ?? null,
      generatedAt: input.generatedAt ?? sourceCompletedAt,
    };
  }
  return {
    rawMemory: null,
    rolloutSummary: null,
    rolloutSlug: null,
    generatedAt:
      status === "succeeded_no_output"
        ? (input.generatedAt ?? sourceCompletedAt)
        : null,
  };
}

function phase2CandidateRow(
  scope: Phase2TestScope,
  input: Phase2CandidateInput,
  sourceHistoryHash: string,
  now: Date,
): typeof piMemoryStage1Candidates.$inferInsert {
  const status = input.status ?? "succeeded";
  const sourceCompletedAt = input.sourceCompletedAt ?? now;
  return {
    memoryStorageId: scope.memoryStorageId,
    orgId: scope.orgId,
    userId: scope.userId,
    piSessionId: input.piSessionId,
    sourceRunId: input.sourceRunId ?? randomUUID(),
    sourceHistoryHash,
    sourceCompletedAt,
    eligibleAt: sourceCompletedAt,
    status,
    leaseToken: input.leaseToken ?? null,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    retryAt: input.retryAt ?? null,
    retryCount: input.retryCount ?? (status === "terminal_failure" ? 3 : 0),
    lastErrorClass:
      input.lastErrorClass ??
      (status === "terminal_failure" ? "attempts_exhausted" : null),
    ...phase2CandidateOutput(input, status, sourceCompletedAt),
    usageCount: input.usageCount ?? 0,
    lastUsedAt: input.lastUsedAt ?? null,
    lastSelectedSourceHistoryHash: input.lastSelectedSourceHistoryHash ?? null,
  };
}

export async function insertPendingPhase2Job(
  scope: Phase2TestScope,
  overrides: Partial<typeof piMemoryPhase2Jobs.$inferInsert> = {},
): Promise<void> {
  await db()
    .insert(piMemoryPhase2Jobs)
    .values({
      ...scope,
      status: "pending",
      inputRevision: 1,
      completedRevision: 0,
      retryCount: 0,
      ...overrides,
    });
}

export async function readPhase2Job(scope: Phase2TestScope) {
  const [job] = await db()
    .select()
    .from(piMemoryPhase2Jobs)
    .where(
      and(
        eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
        eq(piMemoryPhase2Jobs.orgId, scope.orgId),
        eq(piMemoryPhase2Jobs.userId, scope.userId),
      ),
    );
  return job;
}

export async function replacePhase2CandidateSource(args: {
  readonly scope: Phase2TestScope;
  readonly piSessionId: string;
  readonly sourceCompletedAt: Date;
}): Promise<string> {
  const hash = candidateHash(args.scope, `${args.piSessionId}-replacement`);
  await insertFixtureBlobs(args.scope, [hash]);
  await db()
    .update(piMemoryStage1Candidates)
    .set({
      sourceRunId: randomUUID(),
      sourceHistoryHash: hash,
      sourceCompletedAt: args.sourceCompletedAt,
      eligibleAt: args.sourceCompletedAt,
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
      updatedAt: args.sourceCompletedAt,
    })
    .where(
      and(
        eq(
          piMemoryStage1Candidates.memoryStorageId,
          args.scope.memoryStorageId,
        ),
        eq(piMemoryStage1Candidates.orgId, args.scope.orgId),
        eq(piMemoryStage1Candidates.userId, args.scope.userId),
        eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
      ),
    );
  return hash;
}
