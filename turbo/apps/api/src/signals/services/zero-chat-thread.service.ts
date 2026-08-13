import { command, computed, type Computed } from "ccstate";
import {
  type ChatThreadDraft,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type CodexServiceTier,
  type PersistedAttachment,
  type UserMessageInputDocument,
  type ZeroIndicator,
  type ZeroIndicators,
  persistedAttachmentSchema,
  zeroIndicatorSchema,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  type HostedArtifactKind,
  hostedArtifactKindSchema,
} from "@okouai/api-contracts/contracts/zero-host";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { threadGoals } from "@okouai/db/schema/thread-goal";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@okouai/db/schema/run-uploaded-file";
import { zeroAgents } from "@okouai/db/schema/zero-agent";
import { zeroRuns } from "@okouai/db/schema/zero-run";
import { unionAll } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import { zodEnumDriverValueDecoder } from "../../lib/db-structured-result";
import { now } from "../../lib/time";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import { inferMimetype } from "./zero-chat-event-shared.service";
import { latestRunFinishEventSubquery } from "./zero-chat-thread-read-state-query";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./zero-chat-thread-event.service";
import { cancelRun$, type CancelRunResult } from "./zero-run-cancel.service";
import { runOwnedChatEventForRunCondition } from "./zero-chat-event-type.service";
import { cancellationRecoveryPendingForThread } from "./zero-chat-active-run.service";
import { listPendingChatQueueEvents } from "./chat-event-queue.service";

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentComposeId: string;
  readonly draftUserMessage: UserMessageInputDocument | null;
  readonly draftAttachments: readonly PersistedAttachment[] | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly orgId: string | null;
  readonly lastReadAt: Date | null;
  readonly lastMessageAt: Date;
  readonly pinnedAt: Date | null;
  readonly renamedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type ChatThreadDetailRow = {
  readonly lastReadAt: Date | null;
};

function parseHostedArtifactKind(
  value: unknown,
): HostedArtifactKind | undefined {
  const parsed = hostedArtifactKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseHostedArtifactKindFromMetadata(
  metadata: unknown,
): HostedArtifactKind | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  return parseHostedArtifactKind(metadata.artifactKind);
}

function parseHostedArtifactAliasUrlFromMetadata(
  metadata: unknown,
): string | undefined {
  if (!isRecord(metadata) || typeof metadata.aliasUrl !== "string") {
    return undefined;
  }
  return metadata.aliasUrl;
}

function canonicalAssetMaterialization(
  status: "pending" | "ready" | "failed" | null,
  error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null,
): NonNullable<
  ChatThreadArtifactRun["files"][number]["assetRef"]
>["materialization"] {
  if (status === "ready") {
    return { status: "ready" };
  }
  if (status === "pending") {
    return { status: "pending" };
  }
  return {
    status: "failed",
    error: error ?? {
      code: "materialization-failed",
      message: "The attachment could not be imported",
      retryable: false,
    },
  };
}

function ownedChatThread(
  threadId: string,
  userId: string,
): Computed<Promise<ChatThreadRow | null>> {
  return computed(async (get): Promise<ChatThreadRow | null> => {
    const db = get(db$);
    const [thread] = await db
      .select({
        id: chatThreads.id,
        title: chatThreads.title,
        agentComposeId: chatThreads.agentComposeId,
        draftUserMessage: chatThreads.draftUserMessage,
        draftAttachments: chatThreads.draftAttachments,
        computerUseHostId: chatThreads.computerUseHostId,
        cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
        modelProviderId: chatThreads.modelProviderId,
        modelProviderType: chatThreads.modelProviderType,
        modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
        codexServiceTier: chatThreads.codexServiceTier,
        orgId: zeroAgents.orgId,
        lastReadAt: chatThreads.lastReadAt,
        lastMessageAt: chatThreads.lastMessageAt,
        pinnedAt: chatThreads.pinnedAt,
        renamedAt: chatThreads.renamedAt,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
      })
      .from(chatThreads)
      .leftJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
      .limit(1);

    if (!thread) {
      return null;
    }

    return {
      id: thread.id,
      title: thread.title,
      agentComposeId: thread.agentComposeId,
      draftUserMessage: thread.draftUserMessage ?? null,
      draftAttachments: persistedAttachmentSchema
        .array()
        .nullable()
        .parse(thread.draftAttachments ?? null),
      computerUseHostId: thread.computerUseHostId,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
      modelProviderId: thread.modelProviderId,
      modelProviderType: modelProviderTypeSchema
        .nullable()
        .parse(thread.modelProviderType),
      modelProviderCredentialScope: modelProviderCredentialScopeSchema
        .nullable()
        .parse(thread.modelProviderCredentialScope),
      codexServiceTier: thread.codexServiceTier ?? null,
      orgId: thread.orgId ?? null,
      lastReadAt: thread.lastReadAt,
      lastMessageAt: thread.lastMessageAt,
      pinnedAt: thread.pinnedAt ?? null,
      renamedAt: thread.renamedAt ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });
}

export function zeroChatThreadDraft(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDraft | null>> {
  return computed(async (get): Promise<ChatThreadDraft | null> => {
    const thread = await get(ownedChatThread(args.threadId, args.userId));
    if (!thread) {
      return null;
    }

    return {
      draftUserMessage: thread.draftUserMessage,
      draftAttachments: thread.draftAttachments
        ? [...thread.draftAttachments]
        : null,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const INDICATOR_UNREAD_LIMIT = 50;
const INDICATOR_UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const zeroIndicatorDecoder = zodEnumDriverValueDecoder(zeroIndicatorSchema);

function noActiveRunsForCurrentThreadCondition(db: Pick<Db, "select">): SQL {
  return notExists(
    db
      .select({ id: zeroRuns.id })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
      .where(
        and(
          eq(zeroRuns.chatThreadId, chatThreads.id),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
        ),
      ),
  );
}

function noActiveGoalsForCurrentThreadCondition(db: Pick<Db, "select">): SQL {
  return notExists(
    db
      .select({ id: threadGoals.id })
      .from(threadGoals)
      .where(
        and(
          eq(threadGoals.chatThreadId, chatThreads.id),
          eq(threadGoals.status, "active"),
        ),
      ),
  );
}

function ownedChatThreadDetail(
  threadId: string,
  userId: string,
): Computed<Promise<ChatThreadDetailRow | null>> {
  return computed(async (get): Promise<ChatThreadDetailRow | null> => {
    const [thread] = await get(db$)
      .select({
        lastReadAt: chatThreads.lastReadAt,
      })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
      .limit(1);

    if (!thread) {
      return null;
    }

    return {
      lastReadAt: thread.lastReadAt,
    };
  });
}

export function zeroChatThreadDetail(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDetail | null>> {
  return computed(async (get): Promise<ChatThreadDetail | null> => {
    const thread = await get(ownedChatThreadDetail(args.threadId, args.userId));
    if (!thread) {
      return null;
    }
    const cancellationRecoveryPending =
      await cancellationRecoveryPendingForThread(get(db$), {
        threadId: args.threadId,
      });

    return {
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
      cancellationRecoveryPending,
    };
  });
}

/**
 * The user's unread threads under an agent, each with the creation time of
 * the latest run-finish marker. A thread is unread only when it has at least
 * one run-finish marker and that marker is newer than the read watermark.
 */
export function zeroChatThreadUnreads(args: {
  readonly userId: string;
  readonly agentComposeId: string;
}): Computed<Promise<readonly { threadId: string; unreadAt: string }[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
    const rows = await db
      .select({
        threadId: chatThreads.id,
        unreadAt: lastRunFinish.createdAt,
      })
      .from(chatThreads)
      .crossJoinLateral(lastRunFinish)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.agentComposeId, args.agentComposeId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
          ),
          noActiveRunsForCurrentThreadCondition(db),
          noActiveGoalsForCurrentThreadCondition(db),
        ),
      );
    return rows.map((row) => {
      return { threadId: row.threadId, unreadAt: row.unreadAt.toISOString() };
    });
  });
}

/**
 * Agents that currently have at least one unread thread for the user. Uses
 * the same timestamp watermark comparison as `zeroChatThreadUnreads`.
 */
export function zeroChatThreadUnreadAgentIds(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
    const rows = await db
      .selectDistinct({ agentId: chatThreads.agentComposeId })
      .from(chatThreads)
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .crossJoinLateral(lastRunFinish)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(zeroAgents.orgId, args.orgId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
          ),
          noActiveRunsForCurrentThreadCondition(db),
          noActiveGoalsForCurrentThreadCondition(db),
        ),
      );
    return rows.map((row) => {
      return row.agentId;
    });
  });
}

/** The user's unread thread ids in the current organization. */
export function zeroChatThreadUnreadThreadIds(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
    const rows = await db
      .select({ threadId: chatThreads.id })
      .from(chatThreads)
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .crossJoinLateral(lastRunFinish)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(zeroAgents.orgId, args.orgId),
          or(
            isNull(chatThreads.lastReadAt),
            gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
          ),
          noActiveRunsForCurrentThreadCondition(db),
          noActiveGoalsForCurrentThreadCondition(db),
        ),
      );
    return rows.map((row) => {
      return row.threadId;
    });
  });
}

/**
 * Active and unread indicators for the user's agents and threads in the
 * current organization. Active threads are complete; unread threads are the
 * latest 50 terminal markers from the last seven days. Active threads are
 * computed once and reused to keep unread classification and indicator
 * precedence within one database snapshot.
 */
export function zeroChatIndicators(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<ZeroIndicators>> {
  return computed(async (get): Promise<ZeroIndicators> => {
    const db = get(db$);
    const unreadCutoff = new Date(now() - INDICATOR_UNREAD_LOOKBACK_MS);
    const activeThreads = db.$with("active_threads").as(
      db
        .selectDistinct({
          threadId: chatThreads.id,
          agentId: chatThreads.agentComposeId,
        })
        .from(zeroRuns)
        .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
        .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
        .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
        .where(
          and(
            eq(chatThreads.userId, args.userId),
            eq(zeroAgents.orgId, args.orgId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        ),
    );
    const lastRunFinish = latestRunFinishEventSubquery(db, chatThreads.id);
    const unreadThreads = db.$with("unread_threads").as(
      db
        .select({
          threadId: chatThreads.id,
          agentId: chatThreads.agentComposeId,
        })
        .from(chatThreads)
        .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
        .leftJoin(activeThreads, eq(activeThreads.threadId, chatThreads.id))
        .crossJoinLateral(lastRunFinish)
        .where(
          and(
            eq(chatThreads.userId, args.userId),
            eq(zeroAgents.orgId, args.orgId),
            isNull(activeThreads.threadId),
            gte(chatThreads.lastMessageAt, unreadCutoff),
            or(
              isNull(chatThreads.lastReadAt),
              gt(chatThreads.lastMessageAt, chatThreads.lastReadAt),
            ),
            gte(lastRunFinish.createdAt, unreadCutoff),
            or(
              isNull(chatThreads.lastReadAt),
              gt(lastRunFinish.createdAt, chatThreads.lastReadAt),
            ),
            noActiveGoalsForCurrentThreadCondition(db),
          ),
        )
        .orderBy(desc(lastRunFinish.createdAt), desc(chatThreads.id))
        .limit(INDICATOR_UNREAD_LIMIT),
    );
    const indicatorRows = db.$with("indicator_rows").as(
      unionAll(
        db
          .select({
            threadId: activeThreads.threadId,
            agentId: activeThreads.agentId,
            indicator: sql`'active'`
              .mapWith(zeroIndicatorDecoder)
              .as("indicator"),
          })
          .from(activeThreads),
        db
          .select({
            threadId: unreadThreads.threadId,
            agentId: unreadThreads.agentId,
            indicator: sql`'unread'`
              .mapWith(zeroIndicatorDecoder)
              .as("indicator"),
          })
          .from(unreadThreads),
      ),
    );
    const rows = await db
      .with(activeThreads, unreadThreads, indicatorRows)
      .select()
      .from(indicatorRows);

    const agents: Record<string, ZeroIndicator> = {};
    const threads: Record<string, ZeroIndicator> = {};
    for (const row of rows) {
      threads[row.threadId] = row.indicator;
      if (row.indicator === "active" || agents[row.agentId] === undefined) {
        agents[row.agentId] = row.indicator;
      }
    }
    return { agents, threads };
  });
}

/**
 * Chat threads owned by the user in the current org that currently have at
 * least one non-terminal run. Used by local-first thread lists to hydrate the
 * transient sidebar running indicator outside lifecycle event replay.
 */
export function zeroChatThreadActiveRunThreadIds(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const rows = await db
      .selectDistinct({ threadId: zeroRuns.chatThreadId })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
      .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(zeroAgents.orgId, args.orgId),
          isNotNull(zeroRuns.chatThreadId),
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      );

    return rows.flatMap((row) => {
      return row.threadId ? [row.threadId] : [];
    });
  });
}

/**
 * Thread ids owned by the user that currently hold an unsent composer draft
 * (a canonical user message with optional `draftAttachments`).
 */
export function zeroChatThreadDraftIds(args: {
  readonly userId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    const db = get(db$);
    const rows = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          isNotNull(chatThreads.draftUserMessage),
        ),
      );
    return rows.map((row) => {
      return row.id;
    });
  });
}

function loadZeroChatThreadArtifactRows(
  db: ReadonlyDb,
  args: { readonly threadId: string; readonly userId: string },
) {
  return db
    .select({
      assetId: runUploadedFiles.id,
      assetVersion: runUploadedFiles.assetVersion,
      runId: runUploadedFiles.runId,
      externalId: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      sizeBytes: runUploadedFiles.sizeBytes,
      url: runUploadedFiles.url,
      previewImageUrl: runUploadedFiles.previewImageUrl,
      metadata: runUploadedFiles.metadata,
      classification: runUploadedFiles.classification,
      accessLevel: runUploadedFiles.accessLevel,
      materializationStatus: runUploadedFiles.materializationStatus,
      materializationError: runUploadedFiles.materializationError,
      provenance: runUploadedFiles.provenance,
      createdAt: runUploadedFiles.createdAt,
    })
    .from(runUploadedFiles)
    .innerJoin(zeroRuns, eq(zeroRuns.id, runUploadedFiles.runId))
    .innerJoin(agentRuns, eq(agentRuns.id, runUploadedFiles.runId))
    .where(
      and(
        eq(runUploadedFiles.userId, args.userId),
        or(
          eq(zeroRuns.chatThreadId, args.threadId),
          exists(
            db
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                runOwnedChatEventForRunCondition({
                  runId: runUploadedFiles.runId,
                  chatThreadId: args.threadId,
                }),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(agentRuns.createdAt), asc(runUploadedFiles.createdAt));
}

export function zeroChatThreadArtifacts(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<readonly ChatThreadArtifactRun[] | null>> {
  return computed(
    async (get): Promise<readonly ChatThreadArtifactRun[] | null> => {
      const thread = await get(ownedChatThread(args.threadId, args.userId));
      if (!thread) {
        return null;
      }

      const db = get(db$);
      const rows = await loadZeroChatThreadArtifactRows(db, args);

      const hostedArtifactRunIds = new Set(
        rows
          .filter((row) => {
            return (
              row.runId !== null &&
              parseHostedArtifactKindFromMetadata(row.metadata) !== undefined
            );
          })
          .flatMap((row) => {
            return row.runId ? [row.runId] : [];
          }),
      );
      const visibleRows = rows.filter((row) => {
        if (!row.runId) {
          return false;
        }
        const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
        return (
          !hostedArtifactRunIds.has(row.runId) || artifactKind !== undefined
        );
      });

      const rowsByUrl = new Map<string, (typeof visibleRows)[number]>();
      for (const row of visibleRows) {
        if (!row.url) {
          continue;
        }
        rowsByUrl.delete(row.url);
        rowsByUrl.set(row.url, row);
      }

      const byRun = new Map<string, ChatThreadArtifactRun>();
      for (const row of rowsByUrl.values()) {
        if (!row.url || !row.runId) {
          continue;
        }
        const filename = row.filename ?? row.externalId;
        const existing = byRun.get(row.runId) ?? {
          runId: row.runId,
          files: [],
        };
        const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
        const aliasUrl = parseHostedArtifactAliasUrlFromMetadata(row.metadata);
        const canonical =
          row.assetVersion === CANONICAL_ASSET_VERSION &&
          row.classification === "published-output" &&
          row.accessLevel === "published";
        existing.files.push({
          id: canonical ? row.assetId : row.externalId,
          filename,
          contentType: row.contentType ?? inferMimetype(filename),
          size: row.sizeBytes ?? 0,
          url: row.url,
          ...(row.previewImageUrl
            ? { previewImageUrl: row.previewImageUrl }
            : {}),
          ...(aliasUrl ? { aliasUrl } : {}),
          ...(canonical
            ? {
                assetRef: {
                  id: row.assetId,
                  classification: "published-output" as const,
                  access: "published" as const,
                  materialization: canonicalAssetMaterialization(
                    row.materializationStatus,
                    row.materializationError,
                  ),
                  ...(row.provenance
                    ? {
                        provenance: {
                          provider: row.provenance.provider,
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(artifactKind ? { artifactKind } : {}),
          createdAt: row.createdAt.toISOString(),
        });
        byRun.set(row.runId, existing);
      }

      return Array.from(byRun.values()).filter((run) => {
        return run.files.length > 0;
      });
    },
  );
}

export function zeroChatThreadQueuedEvents(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<
  Promise<
    readonly { readonly eventId: string; readonly seqId: number }[] | null
  >
> {
  return computed(async (get) => {
    const owned = await get(ownedChatThread(args.threadId, args.userId));
    if (!owned) {
      return null;
    }

    const events = await listPendingChatQueueEvents(get(db$), args.threadId);
    return events.map((event) => {
      return { eventId: event.id, seqId: event.seqId };
    });
  });
}

export const createChatThread$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId?: string | null;
      readonly agentComposeId: string;
      readonly title: string | undefined;
      readonly clientThreadId: string | undefined;
      readonly eventId: string | undefined;
      readonly modelProviderId: string | null;
      readonly modelProviderType: string | null;
      readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
      readonly selectedModel: string | null;
      readonly codexServiceTier: CodexServiceTier | null;
    },
    signal: AbortSignal,
  ): Promise<{ id: string; createdAt: Date }> => {
    const writeDb = set(writeDb$);
    const thread = await writeDb.transaction(async (tx) => {
      const [createdThread] = await tx
        .insert(chatThreads)
        .values({
          ...(args.clientThreadId !== undefined
            ? { id: args.clientThreadId }
            : {}),
          userId: args.userId,
          agentComposeId: args.agentComposeId,
          title: args.title ?? null,
          lastReadAt: sql`NOW()`,
          modelProviderId: args.modelProviderId,
          modelProviderType: args.modelProviderType,
          modelProviderCredentialScope: args.modelProviderCredentialScope,
          selectedModel: args.selectedModel,
          codexServiceTier: args.codexServiceTier,
        })
        .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
      if (!createdThread) {
        return undefined;
      }
      await appendChatThreadEvent(tx, {
        kind: "created",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: createdThread.id,
        agentComposeId: args.agentComposeId,
        eventId: args.eventId,
        title: args.title ?? null,
        selectedModel: args.selectedModel,
        serviceTier: chatThreadServiceTierFromCodex(args.codexServiceTier),
        computerUseHostId: null,
        cloudBrowserEnabled: false,
        createdAt: createdThread.createdAt,
      });
      return createdThread;
    });
    signal.throwIfAborted();

    if (!thread) {
      throw new Error("Failed to create chat thread");
    }

    return thread;
  },
);

export async function chatThreadForRunFromDb(
  db: Pick<Db, "select">,
  runId: string,
): Promise<{ readonly chatThreadId: string; readonly userId: string } | null> {
  const [row] = await db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);

  if (!row?.chatThreadId) {
    return null;
  }
  return { chatThreadId: row.chatThreadId, userId: row.userId };
}

interface ThreadRunToCancel {
  readonly runId: string;
  readonly orgId: string;
}

/**
 * Delete a chat thread after winding down everything attached to it. Deleting a
 * thread on its own leaves the linked automations firing and any in-flight runs
 * executing: `zero_runs.chatThreadId` is `ON DELETE SET NULL`, so a running run
 * simply loses its thread reference and keeps consuming credits.
 *
 * Lock the thread row while deleting it and collecting active runs. Inserts into
 * `zero_runs.chatThreadId` take a FK lock on the same parent row, so this closes
 * the race where a new run attaches after the active-run scan but before the
 * thread delete. Cancellation still happens after the delete transaction because
 * it has runner notifications and queue-drain side effects.
 *
 * Run cancellation has side effects that cannot participate in the thread's
 * delete transaction (`cancelRun$` opens its own transaction and the runner
 * must be notified), so ownership is verified up front and the cancelled-run
 * results are returned for the caller to dispatch the post-cancel side effects.
 */
export const deleteChatThread$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly orgId?: string | null;
      readonly eventId?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const writeDb = set(writeDb$);

    const deletion = await writeDb.transaction(async (tx) => {
      const [ownedThread] = await tx
        .select({
          id: chatThreads.id,
          agentComposeId: chatThreads.agentComposeId,
        })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.id, args.threadId),
            eq(chatThreads.userId, args.userId),
          ),
        )
        .for("update");
      if (!ownedThread) {
        return {
          deleted: false,
          activeRuns: [] as readonly ThreadRunToCancel[],
        };
      }

      await appendChatThreadEvent(tx, {
        kind: "deleted",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: ownedThread.id,
        agentComposeId: ownedThread.agentComposeId,
        eventId: args.eventId,
      });

      // Capture related active runs while the thread row blocks new FK attaches.
      // Terminal runs (completed/failed/cancelled) are left untouched; only
      // queued/pending/running runs need stopping.
      const activeRuns = await tx
        .select({ runId: agentRuns.id, orgId: agentRuns.orgId })
        .from(zeroRuns)
        .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
        .where(
          and(
            eq(zeroRuns.chatThreadId, ownedThread.id),
            eq(agentRuns.userId, args.userId),
            inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          ),
        );

      // Delete the thread last inside the lock. Cascades chat_events; captured
      // active runs will have their zero_runs.chatThreadId set to NULL.
      const [deletedThread] = await tx
        .delete(chatThreads)
        .where(eq(chatThreads.id, ownedThread.id))
        .returning({ id: chatThreads.id });

      return { deleted: Boolean(deletedThread), activeRuns };
    });
    signal.throwIfAborted();
    if (!deletion.deleted) {
      return { deleted: false, cancelledRuns: [] };
    }

    const cancelledRuns: CancelRunResult[] = [];
    for (const run of deletion.activeRuns) {
      const result = await set(
        cancelRun$,
        {
          runId: run.runId,
          userId: args.userId,
          orgId: run.orgId,
          runnerCancellationMode: "hard",
        },
        signal,
      );
      signal.throwIfAborted();
      // Pre-filtered to active runs, but a concurrent transition can still race
      // a run to a terminal status; cancelRun$ then returns a frozen error
      // response (no `alreadyCancelled` field), which we skip.
      if ("alreadyCancelled" in result) {
        cancelledRuns.push(result);
      }
    }

    return { deleted: true, cancelledRuns };
  },
);

/**
 * Update a chat thread's draft content + attachments.
 *
 * Ownership check via the WHERE clause; missing or cross-user thread → returns
 * `{ updated: false }` so the route handler emits the correct 404. Draft
 * changes do not publish `threadListChanged`: the editing client updates its
 * own sidebar locally, and other clients pick the dot up from the drafts
 * endpoint on their next list reload.
 */
export const updateChatThreadDraft$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly userId: string;
      readonly draftUserMessage: UserMessageInputDocument | null;
      readonly draftAttachments: readonly PersistedAttachment[] | null;
    },
    signal: AbortSignal,
  ): Promise<{ readonly updated: boolean }> => {
    const writeDb = set(writeDb$);
    const updated = await writeDb
      .update(chatThreads)
      .set({
        draftUserMessage: args.draftUserMessage,
        draftAttachments: args.draftAttachments
          ? [...args.draftAttachments]
          : null,
      })
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();

    return { updated: updated.length > 0 };
  },
);
