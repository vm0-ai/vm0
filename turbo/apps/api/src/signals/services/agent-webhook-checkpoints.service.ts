import type { z } from "zod";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
} from "@vm0/api-contracts/contracts/webhooks";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { blobs } from "@vm0/db/schema/blob";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import type { ContextArtifact } from "@vm0/db/types";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { env } from "../../lib/env";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { generatePresignedPutUrl, s3ObjectExists } from "../external/s3";

type CheckpointCreateBody = z.infer<
  typeof webhookCheckpointsContract.create.body
>;
type PrepareHistoryBody = z.infer<
  typeof webhookCheckpointsPrepareHistoryContract.prepare.body
>;

interface CheckpointAuthInput<TBody> {
  readonly auth: SandboxAuth;
  readonly body: TBody;
}

interface AgentComposeSnapshot {
  readonly agentComposeVersionId: string;
  readonly vars?: Record<string, string>;
  readonly secretNames?: readonly string[];
}

interface AdditionalVolumeSnapshot {
  readonly name: string;
  readonly versionId: string;
  readonly mountPath: string;
}

interface EnrichedVolumeVersionsSnapshot {
  readonly versions: Record<string, string>;
  readonly additionalVolumes?: readonly AdditionalVolumeSnapshot[];
}

interface CheckpointRunContext {
  readonly agentComposeVersionId: string | null;
  readonly additionalVolumes: typeof agentRuns.$inferSelect.additionalVolumes;
  readonly secretNames: readonly string[] | null;
  readonly sessionId: string;
  readonly vars: unknown;
}

const L = logger("webhooks:agent:checkpoints");

function recordOfStringsOrUndefined(
  value: unknown,
): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  const result: Record<string, string> = {};
  for (const [key, entryValue] of entries) {
    if (typeof entryValue !== "string") {
      return undefined;
    }
    result[key] = entryValue;
  }

  return result;
}

function artifactSnapshotsForDb(args: {
  readonly snapshots: CheckpointCreateBody["artifactSnapshots"];
}): ContextArtifact[] | null {
  if (!args.snapshots || args.snapshots.length === 0) {
    return null;
  }

  return args.snapshots.map((snapshot) => {
    return {
      name: snapshot.name,
      version: snapshot.version,
      mountPath: snapshot.mountPath,
      ...(snapshot.missingRootPolicy
        ? { missingRootPolicy: snapshot.missingRootPolicy }
        : {}),
    };
  });
}

function responseArtifacts(
  snapshots: CheckpointCreateBody["artifactSnapshots"],
): CheckpointCreateBody["artifactSnapshots"] | undefined {
  return snapshots && snapshots.length > 0 ? snapshots : undefined;
}

function enrichVolumeSnapshot(args: {
  readonly request: CheckpointCreateBody["volumeVersionsSnapshot"];
  readonly additionalVolumes:
    | readonly {
        readonly name: string;
        readonly version?: string;
        readonly mountPath: string;
      }[]
    | null;
}): EnrichedVolumeVersionsSnapshot | null {
  const request = args.request;
  if (!request) {
    return null;
  }

  const additionalVolumes =
    args.additionalVolumes && args.additionalVolumes.length > 0
      ? args.additionalVolumes.map((volume): AdditionalVolumeSnapshot => {
          const versionId =
            request.versions[volume.name] ?? volume.version ?? "latest";
          return {
            name: volume.name,
            versionId,
            mountPath: volume.mountPath,
          };
        })
      : undefined;

  return {
    versions: request.versions,
    ...(additionalVolumes ? { additionalVolumes } : {}),
  };
}

async function loadCheckpointRunContext(
  db: Db,
  input: CheckpointAuthInput<CheckpointCreateBody>,
): Promise<CheckpointRunContext | undefined> {
  const [run] = await db
    .select({
      agentComposeVersionId: agentRuns.agentComposeVersionId,
      additionalVolumes: agentRuns.additionalVolumes,
      secretNames: agentRuns.secretNames,
      sessionId: agentRuns.sessionId,
      vars: agentRuns.vars,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
    .where(
      and(
        eq(agentRuns.id, input.body.runId),
        eq(agentRuns.userId, input.auth.userId),
      ),
    )
    .limit(1);

  return run;
}

export const prepareCheckpointHistoryUpload$ = command(
  async (
    { get, set },
    input: CheckpointAuthInput<PrepareHistoryBody>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, input.body.runId),
          eq(agentRuns.userId, input.auth.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!run) {
      return notFound("Agent run not found");
    }

    const bucketName = env("R2_USER_STORAGES_BUCKET_NAME");
    const s3Key = `blobs/${input.body.hash}.blob`;
    const [existingBlob] = await db
      .select({ hash: blobs.hash })
      .from(blobs)
      .where(eq(blobs.hash, input.body.hash))
      .limit(1);
    signal.throwIfAborted();

    if (existingBlob) {
      const exists = await get(s3ObjectExists(bucketName, s3Key));
      signal.throwIfAborted();
      if (exists) {
        return {
          status: 200 as const,
          body: { existing: true },
        };
      }
    }

    const presignedUrl = await get(
      generatePresignedPutUrl(
        bucketName,
        s3Key,
        "application/octet-stream",
        3600,
        true,
      ),
    );
    signal.throwIfAborted();

    await db
      .insert(blobs)
      .values({ hash: input.body.hash, size: input.body.size, refCount: 0 })
      .onConflictDoUpdate({
        target: blobs.hash,
        set: { size: input.body.size },
      });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        presignedUrl,
        existing: false,
      },
    };
  },
);

export const createAgentCheckpoint$ = command(
  async (
    { set },
    input: CheckpointAuthInput<CheckpointCreateBody>,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const run = await loadCheckpointRunContext(db, input);
    signal.throwIfAborted();

    if (!run) {
      return notFound("Agent run not found");
    }

    if (!run.agentComposeVersionId) {
      return notFound(
        "Agent compose version not found (agent may have been deleted)",
      );
    }

    await db
      .insert(blobs)
      .values({
        hash: input.body.cliAgentSessionHistoryHash,
        size: 0,
        refCount: 1,
      })
      .onConflictDoUpdate({
        target: blobs.hash,
        set: { refCount: sql`${blobs.refCount} + 1` },
      });
    signal.throwIfAborted();

    const [conversation] = await db
      .insert(conversations)
      .values({
        runId: input.body.runId,
        cliAgentType: input.body.cliAgentType,
        cliAgentSessionId: input.body.cliAgentSessionId,
        cliAgentSessionHistoryHash: input.body.cliAgentSessionHistoryHash,
      })
      .onConflictDoUpdate({
        target: conversations.runId,
        set: {
          cliAgentType: input.body.cliAgentType,
          cliAgentSessionId: input.body.cliAgentSessionId,
          cliAgentSessionHistoryHash: input.body.cliAgentSessionHistoryHash,
        },
      })
      .returning({ id: conversations.id });
    signal.throwIfAborted();

    if (!conversation) {
      throw new Error("Failed to upsert conversation record");
    }

    const vars = recordOfStringsOrUndefined(run.vars);
    const agentComposeSnapshot: AgentComposeSnapshot = {
      agentComposeVersionId: run.agentComposeVersionId,
      ...(vars ? { vars } : {}),
      ...(run.secretNames ? { secretNames: run.secretNames } : {}),
    };
    const artifactSnapshots = artifactSnapshotsForDb({
      snapshots: input.body.artifactSnapshots,
    });
    const volumeVersionsSnapshot = enrichVolumeSnapshot({
      request: input.body.volumeVersionsSnapshot,
      additionalVolumes: run.additionalVolumes,
    });

    const checkpointFields = {
      conversationId: conversation.id,
      agentComposeSnapshot,
      artifactSnapshots,
      volumeVersionsSnapshot,
    };
    const [checkpoint] = await db
      .insert(checkpoints)
      .values({
        runId: input.body.runId,
        ...checkpointFields,
      })
      .onConflictDoUpdate({
        target: checkpoints.runId,
        set: checkpointFields,
      })
      .returning({ id: checkpoints.id });
    signal.throwIfAborted();

    if (!checkpoint) {
      throw new Error("Failed to upsert checkpoint record");
    }

    const [agentSession] = await db
      .update(agentSessions)
      .set({
        conversationId: conversation.id,
        updatedAt: nowDate(),
      })
      .where(eq(agentSessions.id, run.sessionId))
      .returning({ id: agentSessions.id });
    signal.throwIfAborted();

    if (!agentSession) {
      return notFound("AgentSession not found");
    }

    L.debug("Checkpoint created", {
      runId: input.body.runId,
      checkpointId: checkpoint.id,
      conversationId: conversation.id,
    });

    return {
      status: 200 as const,
      body: {
        checkpointId: checkpoint.id,
        agentSessionId: agentSession.id,
        conversationId: conversation.id,
        artifacts: responseArtifacts(input.body.artifactSnapshots),
        volumes: input.body.volumeVersionsSnapshot?.versions,
      },
    };
  },
);
