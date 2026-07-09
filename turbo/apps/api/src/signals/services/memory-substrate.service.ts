import { createHash } from "node:crypto";

import type {
  MemorySourceDetailResponse,
  MemorySourceListResponse,
  MemorySourceProvider,
} from "@vm0/api-contracts/contracts/zero-memory";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  memorySources,
  type MemoryProvider,
  type MemorySourceMetadata,
  type MemorySourceType,
} from "@vm0/db/schema/memory-substrate";
import { and, count, desc, eq } from "drizzle-orm";
import type { Db, ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface RecordMemorySourceArgs extends MemoryScope {
  readonly provider: MemoryProvider;
  readonly sourceType: MemorySourceType;
  readonly externalId: string;
  readonly connectorId?: string | null;
  readonly occurredAt?: Date | null;
  readonly title?: string | null;
  readonly contentHash?: string | null;
  readonly metadata: MemorySourceMetadata;
}

export function memoryContentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function memorySubstrateEnabled(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    scope.orgId,
    scope.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.RelationshipMemory, context);
}

export async function recordMemorySource(
  db: Db,
  args: RecordMemorySourceArgs,
): Promise<boolean> {
  if (!(await memorySubstrateEnabled(db, args))) {
    return false;
  }

  const currentTime = nowDate();
  const values: typeof memorySources.$inferInsert = {
    orgId: args.orgId,
    userId: args.userId,
    provider: args.provider,
    sourceType: args.sourceType,
    externalId: args.externalId,
    connectorId: args.connectorId ?? null,
    occurredAt: args.occurredAt ?? null,
    title: args.title ?? null,
    contentHash: args.contentHash ?? null,
    metadata: args.metadata,
    createdAt: currentTime,
    updatedAt: currentTime,
  };

  await db
    .insert(memorySources)
    .values(values)
    .onConflictDoUpdate({
      target: [
        memorySources.orgId,
        memorySources.userId,
        memorySources.provider,
        memorySources.externalId,
      ],
      set: {
        sourceType: values.sourceType,
        connectorId: values.connectorId,
        occurredAt: values.occurredAt,
        title: values.title,
        contentHash: values.contentHash,
        metadata: values.metadata,
        updatedAt: currentTime,
      },
    });

  return true;
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function compactMemorySourceMetadata(
  metadata: MemorySourceMetadata,
): MemorySourceListResponse["sources"][number]["metadata"] {
  return {
    ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
    ...(metadata.channelId ? { channelId: metadata.channelId } : {}),
    ...(metadata.channelType ? { channelType: metadata.channelType } : {}),
    ...(metadata.threadId !== undefined ? { threadId: metadata.threadId } : {}),
    ...(metadata.messageTs ? { messageTs: metadata.messageTs } : {}),
    ...(metadata.senderId ? { senderId: metadata.senderId } : {}),
    ...(metadata.mailboxEmail ? { mailboxEmail: metadata.mailboxEmail } : {}),
    ...(metadata.direction ? { direction: metadata.direction } : {}),
    ...(metadata.githubRepository
      ? { githubRepository: metadata.githubRepository }
      : {}),
    ...(metadata.githubSubjectKind
      ? { githubSubjectKind: metadata.githubSubjectKind }
      : {}),
    ...(metadata.githubSubjectNumber
      ? { githubSubjectNumber: metadata.githubSubjectNumber }
      : {}),
    ...(metadata.githubActorLogin
      ? { githubActorLogin: metadata.githubActorLogin }
      : {}),
    ...(metadata.githubIssueCommentId
      ? { githubIssueCommentId: metadata.githubIssueCommentId }
      : {}),
    ...(metadata.notionWorkspaceName !== undefined
      ? { notionWorkspaceName: metadata.notionWorkspaceName }
      : {}),
    ...(metadata.notionPageId ? { notionPageId: metadata.notionPageId } : {}),
    ...(metadata.notionEventFamily
      ? { notionEventFamily: metadata.notionEventFamily }
      : {}),
    ...(metadata.notionEventType
      ? { notionEventType: metadata.notionEventType }
      : {}),
    ...(metadata.notionParentTitle !== undefined
      ? { notionParentTitle: metadata.notionParentTitle }
      : {}),
  };
}

function serializeMemorySourceMetadata(
  metadata: MemorySourceMetadata,
): MemorySourceDetailResponse["metadata"] {
  return {
    workspaceId: metadata.workspaceId,
    channelId: metadata.channelId,
    channelType: metadata.channelType,
    threadId: metadata.threadId,
    messageId: metadata.messageId,
    messageTs: metadata.messageTs,
    senderId: metadata.senderId,
    participantIds: metadata.participantIds
      ? [...metadata.participantIds]
      : undefined,
    fileIds: metadata.fileIds ? [...metadata.fileIds] : undefined,
    mailboxEmail: metadata.mailboxEmail,
    historyId: metadata.historyId,
    direction: metadata.direction,
    from: metadata.from,
    to: metadata.to ? [...metadata.to] : undefined,
    cc: metadata.cc ? [...metadata.cc] : undefined,
    githubInstallationId: metadata.githubInstallationId,
    githubRemoteInstallationId: metadata.githubRemoteInstallationId,
    githubRepository: metadata.githubRepository,
    githubSubjectKind: metadata.githubSubjectKind,
    githubSubjectNumber: metadata.githubSubjectNumber,
    githubSubjectUrl: metadata.githubSubjectUrl,
    githubIssueCommentId: metadata.githubIssueCommentId,
    githubActorId: metadata.githubActorId,
    githubActorLogin: metadata.githubActorLogin,
    githubAuthorId: metadata.githubAuthorId,
    githubAuthorLogin: metadata.githubAuthorLogin,
    githubLabels: metadata.githubLabels
      ? [...metadata.githubLabels]
      : undefined,
    notionWorkspaceId: metadata.notionWorkspaceId,
    notionWorkspaceName: metadata.notionWorkspaceName,
    notionPageId: metadata.notionPageId,
    notionPageUrl: metadata.notionPageUrl,
    notionLastEditedTime: metadata.notionLastEditedTime,
    notionEventId: metadata.notionEventId,
    notionEventFamily: metadata.notionEventFamily,
    notionEventType: metadata.notionEventType,
    notionScopeType: metadata.notionScopeType,
    notionScopeId: metadata.notionScopeId,
    notionParentTitle: metadata.notionParentTitle,
    notionParentUrl: metadata.notionParentUrl,
    notionAuthorIds: metadata.notionAuthorIds
      ? [...metadata.notionAuthorIds]
      : undefined,
    reason: metadata.reason,
  };
}

function serializeMemorySourceDetail(
  row: typeof memorySources.$inferSelect,
): MemorySourceDetailResponse {
  return {
    id: row.id,
    provider: row.provider,
    sourceType: row.sourceType,
    title: row.title,
    occurredAt: serializeDate(row.occurredAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    externalId: row.externalId,
    connectorId: row.connectorId,
    contentHash: row.contentHash,
    metadata: serializeMemorySourceMetadata(row.metadata),
  };
}

export async function getMemorySourceDetail(
  db: ReadonlyDb,
  args: MemoryScope & { readonly sourceId: string },
): Promise<MemorySourceDetailResponse | null> {
  const [row] = await db
    .select()
    .from(memorySources)
    .where(
      and(
        eq(memorySources.orgId, args.orgId),
        eq(memorySources.userId, args.userId),
        eq(memorySources.id, args.sourceId),
      ),
    )
    .limit(1);

  return row ? serializeMemorySourceDetail(row) : null;
}

export async function listMemorySources(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly provider?: MemorySourceProvider;
    readonly page: number;
    readonly limit: number;
  },
): Promise<MemorySourceListResponse> {
  const where = args.provider
    ? and(
        eq(memorySources.orgId, args.orgId),
        eq(memorySources.userId, args.userId),
        eq(memorySources.provider, args.provider),
      )
    : and(
        eq(memorySources.orgId, args.orgId),
        eq(memorySources.userId, args.userId),
      );

  const offset = (args.page - 1) * args.limit;
  const [[totalRow], rows] = await Promise.all([
    db.select({ value: count() }).from(memorySources).where(where),
    db
      .select({
        id: memorySources.id,
        provider: memorySources.provider,
        sourceType: memorySources.sourceType,
        title: memorySources.title,
        occurredAt: memorySources.occurredAt,
        createdAt: memorySources.createdAt,
        contentHash: memorySources.contentHash,
        metadata: memorySources.metadata,
      })
      .from(memorySources)
      .where(where)
      .orderBy(desc(memorySources.occurredAt), desc(memorySources.createdAt))
      .limit(args.limit)
      .offset(offset),
  ]);

  const total = totalRow?.value ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / args.limit));

  return {
    sources: rows.map((row) => {
      return {
        id: row.id,
        provider: row.provider,
        sourceType: row.sourceType,
        title: row.title,
        occurredAt: serializeDate(row.occurredAt),
        createdAt: row.createdAt.toISOString(),
        contentHash: row.contentHash,
        metadata: compactMemorySourceMetadata(row.metadata),
      };
    }),
    pagination: {
      page: args.page,
      pageSize: args.limit,
      total,
      totalPages,
      hasMore: args.page < totalPages,
    },
  };
}
