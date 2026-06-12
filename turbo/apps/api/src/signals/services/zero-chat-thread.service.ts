import { command, computed, type Computed } from "ccstate";
import {
  type ChatSearchMessage,
  type ChatSearchResult,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type ChatThreadListItem,
  type PagedChatMessage,
  type PersistedAttachment,
  type ResolvedAttachFile,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  type HostedArtifactKind,
  hostedArtifactKindSchema,
} from "@vm0/api-contracts/contracts/zero-host";
import {
  formatRunErrorForExternalSurface,
  isActionableRunError,
  isGenericRunErrorForDisplay,
} from "@vm0/api-contracts/contracts/errors";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageUsagePayload,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageRecommendedFollowupGenerationType,
  type ChatMessageRecommendedFollowups,
  type ChatMessageScheduleSnapshot,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { automations } from "@vm0/db/schema/automation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import {
  buildArtifactPrefix,
  buildFileUrl,
  buildFileUrlFromKey,
} from "../../lib/file-url";
import { type Db, db$, writeDb$ } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { listS3Objects } from "../external/s3";
import { safeJsonParse } from "../utils";
import { cancelRun$, type CancelRunResult } from "./zero-run-cancel.service";

const REPORT_ERROR_STREAK_THRESHOLD = 2;

const CHAT_RUN_REPORTABLE_ERROR_MESSAGE = "An unexpected error occurred.";

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  aac: "audio/aac",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
};

const messageRoleSchema = z.enum(["user", "assistant"]);

type ChatMessageRow = {
  readonly id: string;
  readonly role: string;
  readonly content: string | null;
  readonly runId: string | null;
  readonly usagePayload: ChatMessageUsagePayload | null;
  readonly runEventId: string | null;
  readonly error: string | null;
  readonly runLifecycleEvent: string | null;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly recommendedFollowups: ChatMessageRecommendedFollowups | null;
  readonly scheduleSnapshot: ChatMessageScheduleSnapshot | null;
  readonly revokesMessageId: string | null;
  readonly interruptsRunId: string | null;
  readonly scheduleId: string | null;
  readonly scheduleTitle: string | null;
};

type ChatSearchMessageRow = {
  readonly messageId: string;
  readonly chatThreadId: string;
  readonly role: string;
  readonly content: string | null;
  readonly createdAt: Date;
  readonly sequenceNumber: number | null;
  readonly runId: string | null;
};

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentComposeId: string;
  readonly draftContent: string | null;
  readonly draftAttachments: readonly PersistedAttachment[] | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: string | null;
  readonly selectedModel: string | null;
  readonly computerUseHostId: string | null;
  readonly orgId: string | null;
  readonly lastReadAt: Date | null;
  readonly lastReadMessageId: string | null;
  readonly lastMessageAt: Date;
  readonly renamedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type ChatThreadModelPin = {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: string | null;
  readonly selectedModel: string | null;
};

function effectiveChatMessageRunId() {
  return chatMessages.runId;
}

/**
 * Advances chat_threads.last_message_at to NOW(), but only forward — GREATEST
 * guards against an out-of-order write rewinding the column and silently
 * pulling a thread back down the sidebar.
 *
 * The sidebar orders threads by this column, and we deliberately bump it only
 * for terminal runs that produce visible assistant text (including failure
 * text), not on user sends, usage rows, pure lifecycle markers, or mid-stream
 * assistant events. So a thread surfaces to the top when there is new text for
 * the user to read, not the moment they hit send.
 */
export async function touchChatThreadLastMessageAt(
  tx: Pick<Db, "update">,
  threadId: string,
): Promise<void> {
  await tx
    .update(chatThreads)
    .set({
      lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, NOW())`,
    })
    .where(eq(chatThreads.id, threadId));
}

export function visibleChatMessageCondition() {
  return sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM ${chatMessages} AS revoker
      WHERE revoker.revokes_message_id = ${chatMessages.id}
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.revokesMessageId} IS NOT NULL
      AND ${chatMessages.content} IS NULL
      AND ${chatMessages.error} IS NULL
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.interruptsRunId} IS NOT NULL
    )`;
}

const messageColumns = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  runId: effectiveChatMessageRunId(),
  usagePayload: chatMessages.usagePayload,
  runEventId: chatMessages.runEventId,
  error: chatMessages.error,
  runLifecycleEvent: chatMessages.runLifecycleEvent,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  attachFiles: chatMessages.attachFiles,
  attachFileMetadata: chatMessages.attachFileMetadata,
  generationTemplate: chatMessages.generationTemplate,
  recommendedFollowups: chatMessages.recommendedFollowups,
  scheduleSnapshot: chatMessages.scheduleSnapshot,
  revokesMessageId: chatMessages.revokesMessageId,
  interruptsRunId: chatMessages.interruptsRunId,
  scheduleId: chatMessages.scheduleId,
  scheduleTitle: chatMessages.scheduleTitle,
} as const;

const searchMessageColumns = {
  messageId: chatMessages.id,
  chatThreadId: chatMessages.chatThreadId,
  role: chatMessages.role,
  content: chatMessages.content,
  createdAt: chatMessages.createdAt,
  sequenceNumber: chatMessages.sequenceNumber,
  runId: effectiveChatMessageRunId(),
} as const;

function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, String.raw`\\`)
    .replace(/%/g, String.raw`\%`)
    .replace(/_/g, String.raw`\_`);
}

function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext
    ? (EXT_MIMETYPE_MAP[ext] ?? "application/octet-stream")
    : "application/octet-stream";
}

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

function buildReportableErrorMessage(runId: string): string {
  return `${CHAT_RUN_REPORTABLE_ERROR_MESSAGE} [Report this issue](/runs/${encodeURIComponent(runId)}/report-error)`;
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
        draftContent: chatThreads.draftContent,
        draftAttachments: chatThreads.draftAttachments,
        computerUseHostId: chatThreads.computerUseHostId,
        selectedModel: chatThreads.selectedModel,
        orgId: zeroAgents.orgId,
        lastReadAt: chatThreads.lastReadAt,
        lastReadMessageId: chatThreads.lastReadMessageId,
        lastMessageAt: chatThreads.lastMessageAt,
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
      draftContent: thread.draftContent ?? null,
      draftAttachments: persistedAttachmentSchema
        .array()
        .nullable()
        .parse(thread.draftAttachments ?? null),
      computerUseHostId: thread.computerUseHostId,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: thread.selectedModel ?? null,
      orgId: thread.orgId ?? null,
      lastReadAt: thread.lastReadAt ?? null,
      lastReadMessageId: thread.lastReadMessageId ?? null,
      lastMessageAt: thread.lastMessageAt,
      renamedAt: thread.renamedAt ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });
}

function firstRunModelPinForThread(
  threadId: string,
): Computed<Promise<ChatThreadModelPin | null>> {
  return computed(async (get): Promise<ChatThreadModelPin | null> => {
    const [run] = await get(db$)
      .select({ selectedModel: zeroRuns.selectedModel })
      .from(chatMessages)
      .innerJoin(zeroRuns, eq(zeroRuns.id, chatMessages.runId))
      .where(
        and(
          eq(chatMessages.chatThreadId, threadId),
          eq(chatMessages.role, "user"),
          isNotNull(chatMessages.runId),
          isNotNull(zeroRuns.selectedModel),
        ),
      )
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
      .limit(1);

    if (!run?.selectedModel) {
      return null;
    }
    return {
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: run.selectedModel,
    };
  });
}

function effectiveModelFirstThreadPin(params: {
  readonly thread: ChatThreadRow;
  readonly userId: string;
}): Computed<Promise<ChatThreadModelPin | null>> {
  return computed(async (get): Promise<ChatThreadModelPin | null> => {
    if (params.thread.selectedModel !== null) {
      return {
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: params.thread.selectedModel,
      };
    }
    if (!params.thread.orgId) {
      return null;
    }
    return await get(firstRunModelPinForThread(params.thread.id));
  });
}

export function resolveAttachFileUrls(
  userId: string,
  fileIds: readonly string[],
): Computed<Promise<readonly ResolvedAttachFile[]>> {
  return computed(async (get): Promise<readonly ResolvedAttachFile[]> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const resolved = await Promise.all(
      fileIds.map(async (fileId): Promise<ResolvedAttachFile | null> => {
        const prefix = buildArtifactPrefix(userId, fileId);
        const objects = await get(listS3Objects(bucket, prefix));
        const object = objects[0];
        if (!object) {
          return null;
        }

        const filename = object.key.split("/").pop() ?? fileId;
        return {
          id: fileId,
          filename,
          contentType: inferMimetype(filename),
          size: object.size,
          url: buildFileUrl(userId, fileId, filename),
        };
      }),
    );

    return resolved.filter((file): file is ResolvedAttachFile => {
      return file !== null;
    });
  });
}

export function resolveAttachFileMetadataUrls(
  metadata: readonly ChatMessageAttachFileMetadata[],
): readonly ResolvedAttachFile[] {
  return metadata.map((file) => {
    return {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      url: buildFileUrlFromKey(file.objectKey),
    };
  });
}

function chatMessageAttachFiles(
  userId: string,
  row: ChatMessageRow,
): Computed<Promise<readonly ResolvedAttachFile[] | undefined>> {
  return computed(async (get) => {
    if (row.attachFileMetadata && row.attachFileMetadata.length > 0) {
      return resolveAttachFileMetadataUrls(row.attachFileMetadata);
    }
    if (row.attachFiles && row.attachFiles.length > 0) {
      return await get(resolveAttachFileUrls(userId, row.attachFiles));
    }
    return undefined;
  });
}

function genericErrorStreakForRun(params: {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly currentErrorMessage: string;
}): Computed<Promise<number>> {
  return computed(async (get): Promise<number> => {
    const rows = await get(db$)
      .select({
        runId: zeroRuns.id,
        error: agentRuns.error,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(zeroRuns.chatThreadId, params.chatThreadId))
      .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));

    let streak = 0;
    for (const row of rows) {
      const errorMessage =
        row.runId === params.runId ? params.currentErrorMessage : row.error;
      if (!errorMessage?.trim() || isActionableRunError(errorMessage)) {
        streak = 0;
      } else {
        streak += 1;
      }

      if (row.runId === params.runId) {
        return streak;
      }
    }

    return 1;
  });
}

export function formatRunErrorLikeWebMessage(params: {
  readonly chatThreadId?: string | null;
  readonly runId: string;
  readonly errorMessage: string;
}): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const errorMessage = params.errorMessage.trim() || "Run failed";
    const displayErrorMessage = formatRunErrorForExternalSurface({
      code: "INTERNAL_SERVER_ERROR",
      message: errorMessage,
    });
    if (!isGenericRunErrorForDisplay(errorMessage)) {
      return displayErrorMessage;
    }
    if (!params.chatThreadId) {
      return displayErrorMessage;
    }

    const streak = await get(
      genericErrorStreakForRun({
        chatThreadId: params.chatThreadId,
        runId: params.runId,
        currentErrorMessage: errorMessage,
      }),
    );

    return streak >= REPORT_ERROR_STREAK_THRESHOLD
      ? buildReportableErrorMessage(params.runId)
      : displayErrorMessage;
  });
}

export function formatChatRunErrorMessage(params: {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly errorMessage: string;
}): Computed<Promise<string>> {
  return formatRunErrorLikeWebMessage(params);
}

function lifecycleEventOrUndefined(
  value: string | null,
): "completed" | "failed" | "cancelled" | undefined {
  if (value === "completed" || value === "failed" || value === "cancelled") {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecommendedFollowupGenerationType(
  value: unknown,
): value is ChatMessageRecommendedFollowupGenerationType {
  return (
    value === "image" ||
    value === "video" ||
    value === "presentation" ||
    value === "website"
  );
}

function normalizeRecommendedFollowups(
  value: unknown,
): ChatMessageRecommendedFollowups | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const followups: ChatMessageRecommendedFollowups = [];
  for (const item of value) {
    const prompt =
      typeof item === "string"
        ? item.trim()
        : isRecord(item) && typeof item.prompt === "string"
          ? item.prompt.trim()
          : "";
    if (prompt.length === 0 || seen.has(prompt)) {
      continue;
    }
    seen.add(prompt);

    if (!isRecord(item) || item.kind !== "generate") {
      followups.push({ prompt, kind: "talk" });
      continue;
    }

    followups.push({
      prompt,
      kind: "generate",
      ...(isRecommendedFollowupGenerationType(item.generationType)
        ? { generationType: item.generationType }
        : {}),
    });
  }

  return followups.length > 0 ? followups : undefined;
}

function normalizeUsagePayload(
  value: ChatMessageUsagePayload | null,
): PagedChatMessage["usage"] {
  if (value === null) {
    return undefined;
  }

  return {
    version: value.version,
    totalCredits: value.totalCredits,
    settledAt: value.settledAt,
    breakdown: value.breakdown.map((kind) => {
      return {
        kind: kind.kind,
        credits: kind.credits,
        providers: kind.providers.map((provider) => {
          return {
            provider: provider.provider,
            credits: provider.credits,
          };
        }),
      };
    }),
  };
}

function toPagedMessage(
  userId: string,
  row: ChatMessageRow,
): Computed<Promise<PagedChatMessage>> {
  return computed(async (get): Promise<PagedChatMessage> => {
    const attachFiles = await get(chatMessageAttachFiles(userId, row));

    const role = messageRoleSchema.parse(row.role);
    const message = {
      id: row.id,
      role,
      content: row.content,
      runId: row.runId ?? undefined,
      usage: normalizeUsagePayload(row.usagePayload),
      runEventId: row.runEventId ?? undefined,
      revokesMessageId: row.revokesMessageId ?? undefined,
      interruptsRunId: row.interruptsRunId ?? undefined,
      error: row.error ?? undefined,
      attachFiles: attachFiles ? [...attachFiles] : undefined,
      generationTemplate: row.generationTemplate ?? undefined,
      createdAt: row.createdAt.toISOString(),
    };
    if (role !== "assistant") {
      return {
        ...message,
        role: "user" as const,
        scheduleId: row.scheduleId ?? undefined,
        scheduleTitle: row.scheduleTitle ?? undefined,
        scheduleSnapshot: row.scheduleSnapshot ?? undefined,
      };
    }
    return {
      ...message,
      role: "assistant" as const,
      runLifecycleEvent: lifecycleEventOrUndefined(row.runLifecycleEvent),
      recommendedFollowups: normalizeRecommendedFollowups(
        row.recommendedFollowups,
      ),
    };
  });
}

// Single zero_runs JOIN agent_runs scan used to derive activeRunIds in JS,
// paying the join cost once on the hot chat-thread detail path. Rows are
// ordered newest-first.
function isActiveRunStatus(status: string): boolean {
  return status === "queued" || status === "pending" || status === "running";
}

interface ThreadRunSummaryRow {
  readonly id: string;
  readonly status: string;
}

function threadRunSummaries(
  threadId: string,
): Computed<Promise<readonly ThreadRunSummaryRow[]>> {
  return computed(async (get): Promise<readonly ThreadRunSummaryRow[]> => {
    return await get(db$)
      .select({
        id: zeroRuns.id,
        status: agentRuns.status,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(zeroRuns.chatThreadId, threadId))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id));
  });
}

function pickActiveRunIds(
  rows: readonly ThreadRunSummaryRow[],
): readonly string[] {
  const active: string[] = [];
  for (const row of rows) {
    if (isActiveRunStatus(row.status)) {
      active.push(row.id);
    }
  }
  return active;
}

export function zeroChatThreadDetail(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<ChatThreadDetail | null>> {
  return computed(async (get): Promise<ChatThreadDetail | null> => {
    const thread = await get(ownedChatThread(args.threadId, args.userId));
    if (!thread) {
      return null;
    }

    const [runSummaries, modelPin] = await Promise.all([
      get(threadRunSummaries(args.threadId)),
      get(effectiveModelFirstThreadPin({ thread, userId: args.userId })),
    ]);
    return {
      id: thread.id,
      title: thread.title,
      agentId: thread.agentComposeId,
      lastReadMessageId: thread.lastReadMessageId,
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
      lastMessageAt: thread.lastMessageAt.toISOString(),
      activeRunIds: [...pickActiveRunIds(runSummaries)],
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      draftContent: thread.draftContent,
      draftAttachments: thread.draftAttachments
        ? [...thread.draftAttachments]
        : null,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelPin?.selectedModel ?? thread.selectedModel,
      renamedAt: thread.renamedAt?.toISOString() ?? null,
    };
  });
}

const SIDEBAR_CHAT_THREAD_LIMIT = 25;

interface ChatThreadListCursor {
  readonly lastMessageAt: Date;
  readonly id: string;
}

function encodeChatThreadListCursor(cursor: ChatThreadListCursor): string {
  return Buffer.from(
    JSON.stringify({
      ts: cursor.lastMessageAt.toISOString(),
      id: cursor.id,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeChatThreadListCursor(
  raw: string | undefined,
): ChatThreadListCursor | null {
  if (!raw) {
    return null;
  }
  const parsed = safeJsonParse(Buffer.from(raw, "base64url").toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("ts" in parsed) ||
    !("id" in parsed)
  ) {
    return null;
  }
  const ts = (parsed as { ts: unknown }).ts;
  const id = (parsed as { id: unknown }).id;
  if (typeof ts !== "string" || typeof id !== "string") {
    return null;
  }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return { lastMessageAt: date, id };
}

interface ChatThreadListPage {
  readonly pinned: readonly ChatThreadListItem[];
  readonly threads: readonly ChatThreadListItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

function lastVisibleMessageSubquery(db: Pick<Db, "select">) {
  return db
    .select({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, chatThreads.id),
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1)
    .as("last_message");
}

function chatThreadListProjection() {
  return {
    id: chatThreads.id,
    title: chatThreads.title,
    agentId: chatThreads.agentComposeId,
    agentAvatarUrl: zeroAgents.avatarUrl,
    createdAt: chatThreads.createdAt,
    updatedAt: chatThreads.updatedAt,
    pinnedAt: chatThreads.pinnedAt,
    renamedAt: chatThreads.renamedAt,
    lastMessageAt: chatThreads.lastMessageAt,
    running: sql<boolean>`EXISTS (
      SELECT 1
      FROM ${zeroRuns}
      INNER JOIN ${agentRuns} ON ${agentRuns.id} = ${zeroRuns.id}
      WHERE ${zeroRuns.chatThreadId} = ${chatThreads.id}
        AND ${agentRuns.status} IN ('queued', 'pending', 'running')
    )`,
  } as const;
}

type ChatThreadListRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentId: string;
  readonly agentAvatarUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly pinnedAt: Date | null;
  readonly renamedAt: Date | null;
  readonly lastMessageAt: Date;
  readonly running: boolean;
};

function rowToChatThreadListItem(
  thread: ChatThreadListRow,
): ChatThreadListItem {
  return {
    id: thread.id,
    title: thread.title,
    agent: {
      id: thread.agentId,
      avatarUrl: thread.agentAvatarUrl,
    },
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    running: thread.running,
    pinnedAt: thread.pinnedAt?.toISOString() ?? null,
    renamedAt: thread.renamedAt?.toISOString() ?? null,
  };
}

function cursorAdvanceFilter(cursor: ChatThreadListCursor) {
  return or(
    lt(chatThreads.lastMessageAt, cursor.lastMessageAt),
    and(
      eq(chatThreads.lastMessageAt, cursor.lastMessageAt),
      lt(chatThreads.id, cursor.id),
    ),
  )!;
}

export function zeroChatThreadList(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}): Computed<Promise<ChatThreadListPage>> {
  return computed(async (get): Promise<ChatThreadListPage> => {
    const db = get(db$);
    const limit = args.limit ?? SIDEBAR_CHAT_THREAD_LIMIT;
    const cursor = decodeChatThreadListCursor(args.cursor);

    const projection = chatThreadListProjection();

    const scopedFilters = [
      eq(chatThreads.userId, args.userId),
      eq(zeroAgents.orgId, args.orgId),
    ];
    if (args.agentComposeId) {
      scopedFilters.push(eq(chatThreads.agentComposeId, args.agentComposeId));
    }

    const nonPinnedFilters = [...scopedFilters, isNull(chatThreads.pinnedAt)];
    if (cursor) {
      nonPinnedFilters.push(cursorAdvanceFilter(cursor));
    }

    // Pinned segment is only returned on the first page (no cursor).
    // Honours the same agent scope as the non-pinned segment so the sidebar
    // never surfaces another agent's pinned threads while you're viewing one.
    // Both segments are independent, so they run in parallel to avoid
    // stacking two sequential round-trips on this hot path.
    const [pinnedRows, nonPinnedRows] = await Promise.all([
      cursor
        ? []
        : db
            .select(projection)
            .from(chatThreads)
            .innerJoin(
              zeroAgents,
              eq(zeroAgents.id, chatThreads.agentComposeId),
            )
            .where(and(...scopedFilters, isNotNull(chatThreads.pinnedAt)))
            .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id)),
      db
        .select(projection)
        .from(chatThreads)
        .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
        .where(and(...nonPinnedFilters))
        .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
        .limit(limit + 1),
    ]);

    const hasMore = nonPinnedRows.length > limit;
    const pageRows = hasMore ? nonPinnedRows.slice(0, limit) : nonPinnedRows;
    const lastRow = hasMore ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor = lastRow
      ? encodeChatThreadListCursor({
          lastMessageAt: lastRow.lastMessageAt,
          id: lastRow.id,
        })
      : null;

    return {
      pinned: pinnedRows.map(rowToChatThreadListItem),
      threads: pageRows.map(rowToChatThreadListItem),
      hasMore,
      nextCursor,
    };
  });
}

/**
 * The user's unread threads under an agent, each with the creation time of
 * the latest visible message — the one that made the thread unread. A thread
 * is unread when it has at least one visible message and the read cursor
 * (`lastReadMessageId`) doesn't point at the latest one.
 */
export function zeroChatThreadUnreads(args: {
  readonly userId: string;
  readonly agentComposeId: string;
}): Computed<Promise<readonly { threadId: string; unreadAt: string }[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastMessage = lastVisibleMessageSubquery(db);
    const rows = await db
      .select({
        threadId: chatThreads.id,
        unreadAt: lastMessage.createdAt,
      })
      .from(chatThreads)
      .leftJoinLateral(lastMessage, sql`true`)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.agentComposeId, args.agentComposeId),
          isNotNull(lastMessage.id),
          or(
            isNull(chatThreads.lastReadMessageId),
            sql`${chatThreads.lastReadMessageId} <> ${lastMessage.id}`,
          ),
        ),
      );
    return rows.flatMap((row) => {
      // Always present: the isNotNull(lastMessage.id) filter guarantees a
      // joined row, but the left-lateral type keeps the column nullable.
      if (row.unreadAt === null) {
        return [];
      }
      return [{ threadId: row.threadId, unreadAt: row.unreadAt.toISOString() }];
    });
  });
}

/**
 * Of the given thread ids, the ones owned by the user that currently hold an
 * unsent composer draft (non-empty `draftContent` or one+ `draftAttachments`).
 */
export function zeroChatThreadDraftIds(args: {
  readonly userId: string;
  readonly threadIds: readonly string[];
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    if (args.threadIds.length === 0) {
      return [];
    }
    const db = get(db$);
    const rows = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          inArray(chatThreads.id, [...args.threadIds]),
          sql`(
            COALESCE(${chatThreads.draftContent}, '') <> ''
            OR (
              ${chatThreads.draftAttachments} IS NOT NULL
              AND jsonb_array_length(${chatThreads.draftAttachments}) > 0
            )
          )`,
        ),
      );
    return rows.map((row) => {
      return row.id;
    });
  });
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

      const rows = await get(db$)
        .select({
          runId: runUploadedFiles.runId,
          externalId: runUploadedFiles.externalId,
          filename: runUploadedFiles.filename,
          contentType: runUploadedFiles.contentType,
          sizeBytes: runUploadedFiles.sizeBytes,
          url: runUploadedFiles.url,
          metadata: runUploadedFiles.metadata,
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
              sql`EXISTS (
                SELECT 1
                FROM ${chatMessages}
                WHERE ${chatMessages.runId} = ${runUploadedFiles.runId}
                  AND ${chatMessages.chatThreadId} = ${args.threadId}
              )`,
            ),
          ),
        )
        .orderBy(asc(agentRuns.createdAt), asc(runUploadedFiles.createdAt));

      const hostedArtifactRunIds = new Set(
        rows
          .filter((row) => {
            return (
              parseHostedArtifactKindFromMetadata(row.metadata) !== undefined
            );
          })
          .map((row) => {
            return row.runId;
          }),
      );
      const visibleRows = rows.filter((row) => {
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
        if (!row.url) {
          continue;
        }
        const filename = row.filename ?? row.externalId;
        const existing = byRun.get(row.runId) ?? {
          runId: row.runId,
          files: [],
        };
        const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
        existing.files.push({
          id: row.externalId,
          filename,
          contentType: row.contentType ?? inferMimetype(filename),
          size: row.sizeBytes ?? 0,
          url: row.url,
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

function toChatSearchMessage(row: ChatSearchMessageRow): ChatSearchMessage {
  if (row.content === null) {
    throw new Error(
      "chat search invariant violated: message content is null despite isNotNull filter",
    );
  }

  return {
    messageId: row.messageId,
    chatThreadId: row.chatThreadId,
    role: messageRoleSchema.parse(row.role),
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    sequenceNumber: row.sequenceNumber,
    runId: row.runId,
  };
}

export function zeroChatSearch(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly keyword: string;
  readonly agentId?: string;
  readonly since?: number;
  readonly limit: number;
  readonly before: number;
  readonly after: number;
}): Computed<
  Promise<{
    readonly results: readonly ChatSearchResult[];
    readonly hasMore: boolean;
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const pattern = `%${escapeLikePattern(args.keyword)}%`;
    const sinceDate = args.since ? new Date(args.since) : undefined;

    const matchConditions = [
      eq(chatThreads.userId, args.userId),
      eq(agentComposes.orgId, args.orgId),
      isNotNull(chatMessages.content),
      visibleChatMessageCondition(),
      ilike(chatMessages.content, pattern),
    ];
    if (sinceDate) {
      matchConditions.push(gte(chatMessages.createdAt, sinceDate));
    }
    if (args.agentId) {
      matchConditions.push(eq(zeroAgents.id, args.agentId));
    }

    const matches = await db
      .select({
        ...searchMessageColumns,
        agentName: agentComposes.name,
      })
      .from(chatMessages)
      .innerJoin(chatThreads, eq(chatMessages.chatThreadId, chatThreads.id))
      .innerJoin(
        agentComposes,
        eq(chatThreads.agentComposeId, agentComposes.id),
      )
      .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(and(...matchConditions))
      .orderBy(desc(chatMessages.createdAt))
      .limit(args.limit + 1);

    const hasMore = matches.length > args.limit;
    const truncated = hasMore ? matches.slice(0, args.limit) : matches;

    const results = await Promise.all(
      truncated.map(async (match): Promise<ChatSearchResult> => {
        const [contextBeforeRows, contextAfterRows] = await Promise.all([
          args.before > 0
            ? db
                .select(searchMessageColumns)
                .from(chatMessages)
                .where(
                  and(
                    eq(chatMessages.chatThreadId, match.chatThreadId),
                    lt(chatMessages.createdAt, match.createdAt),
                    isNotNull(chatMessages.content),
                    visibleChatMessageCondition(),
                  ),
                )
                .orderBy(desc(chatMessages.createdAt))
                .limit(args.before)
            : Promise.resolve([] as ChatSearchMessageRow[]),
          args.after > 0
            ? db
                .select(searchMessageColumns)
                .from(chatMessages)
                .where(
                  and(
                    eq(chatMessages.chatThreadId, match.chatThreadId),
                    gt(chatMessages.createdAt, match.createdAt),
                    isNotNull(chatMessages.content),
                    visibleChatMessageCondition(),
                  ),
                )
                .orderBy(asc(chatMessages.createdAt))
                .limit(args.after)
            : Promise.resolve([] as ChatSearchMessageRow[]),
        ]);

        return {
          chatThreadId: match.chatThreadId,
          agentName: match.agentName,
          matchedMessage: toChatSearchMessage(match),
          contextBefore: contextBeforeRows
            .slice()
            .reverse()
            .map(toChatSearchMessage),
          contextAfter: contextAfterRows.map(toChatSearchMessage),
        };
      }),
    );

    return { results, hasMore };
  });
}

export function zeroChatThreadMessagesPage(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly sinceId: string | undefined;
  readonly beforeId: string | undefined;
  readonly limit: number;
}): Computed<
  Promise<{
    readonly messages: readonly PagedChatMessage[];
    readonly hasHistoryBefore: boolean;
  } | null>
> {
  return computed(async (get) => {
    const owned = await get(ownedChatThread(args.threadId, args.userId));
    if (!owned) {
      return null;
    }

    if (args.sinceId !== undefined && args.beforeId !== undefined) {
      throw new Error("sinceId and beforeId are mutually exclusive");
    }

    const db = get(db$);
    const threadFilter = eq(chatMessages.chatThreadId, args.threadId);
    let rows: ChatMessageRow[];
    let hasHistoryBefore = false;

    if (args.sinceId === undefined && args.beforeId === undefined) {
      const latestRows = await db
        .select(messageColumns)
        .from(chatMessages)
        .where(threadFilter)
        .orderBy(
          desc(chatMessages.createdAt),
          desc(chatMessages.sequenceNumber),
        )
        .limit(args.limit + 1);
      hasHistoryBefore = latestRows.length > args.limit;
      rows = latestRows.slice(0, args.limit).reverse();
    } else {
      const cursorId = args.sinceId ?? args.beforeId;
      if (cursorId === undefined) {
        throw new Error("message cursor is required");
      }
      const cursorAfterCondition = sql`(
        ${chatMessages.createdAt},
        COALESCE(${chatMessages.sequenceNumber}, -1)
      ) > (
        SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
        FROM ${chatMessages}
        WHERE ${chatMessages.id} = ${cursorId}
      )`;
      const cursorBeforeCondition = sql`(
        ${chatMessages.createdAt},
        COALESCE(${chatMessages.sequenceNumber}, -1)
      ) < (
        SELECT ${chatMessages.createdAt}, COALESCE(${chatMessages.sequenceNumber}, -1)
        FROM ${chatMessages}
        WHERE ${chatMessages.id} = ${cursorId}
      )`;

      if (args.sinceId !== undefined) {
        rows = await db
          .select(messageColumns)
          .from(chatMessages)
          .where(and(threadFilter, cursorAfterCondition))
          .orderBy(
            asc(chatMessages.createdAt),
            asc(chatMessages.sequenceNumber),
          )
          .limit(args.limit);
      } else {
        const previousRows = await db
          .select(messageColumns)
          .from(chatMessages)
          .where(and(threadFilter, cursorBeforeCondition))
          .orderBy(
            desc(chatMessages.createdAt),
            desc(chatMessages.sequenceNumber),
          )
          .limit(args.limit + 1);
        hasHistoryBefore = previousRows.length > args.limit;
        rows = previousRows.slice(0, args.limit).reverse();
      }
    }

    return {
      messages: await Promise.all(
        rows.map((row) => {
          return get(toPagedMessage(args.userId, row));
        }),
      ),
      hasHistoryBefore,
    };
  });
}

export const createChatThread$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly agentComposeId: string;
      readonly title: string | undefined;
      readonly clientThreadId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<{ id: string; createdAt: Date }> => {
    const writeDb = set(writeDb$);
    const [thread] = await writeDb
      .insert(chatThreads)
      .values({
        ...(args.clientThreadId !== undefined
          ? { id: args.clientThreadId }
          : {}),
        userId: args.userId,
        agentComposeId: args.agentComposeId,
        title: args.title ?? null,
        lastReadAt: sql`NOW()`,
      })
      .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
    signal.throwIfAborted();

    if (!thread) {
      throw new Error("Failed to create chat thread");
    }

    return thread;
  },
);

export function chatThreadForRun(
  runId: string,
): Computed<
  Promise<{ readonly chatThreadId: string; readonly userId: string } | null>
> {
  return computed(async (get) => {
    const db = get(db$);
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
  });
}

export const insertAssistantEventMessages$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly threadId: string;
      readonly userId: string;
      readonly items: readonly {
        readonly sequenceNumber: number;
        readonly content: string;
        readonly runEventId?: string;
      }[];
    },
    signal: AbortSignal,
  ): Promise<number> => {
    if (args.items.length === 0) {
      return 0;
    }

    const writeDb = set(writeDb$);
    const rows = await writeDb
      .insert(chatMessages)
      .values(
        args.items.map((item) => {
          return {
            chatThreadId: args.threadId,
            runId: args.runId,
            role: "assistant",
            content: item.content,
            sequenceNumber: item.sequenceNumber,
            runEventId: item.runEventId ?? null,
          };
        }),
      )
      .onConflictDoNothing({
        target: [chatMessages.runId, chatMessages.sequenceNumber],
      })
      .returning({ id: chatMessages.id });
    signal.throwIfAborted();

    if (rows.length > 0) {
      await publishUserSignal(
        [args.userId],
        `chatThreadMessageCreated:${args.threadId}`,
      );
      signal.throwIfAborted();

      await publishThreadListChanged(args.userId);
      signal.throwIfAborted();
    }

    return rows.length;
  },
);

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;

/**
 * Delete a chat thread after winding down everything attached to it. Deleting a
 * thread on its own leaves the linked schedules firing and any in-flight runs
 * executing: `zero_runs.chatThreadId` is `ON DELETE SET NULL`, so a running run
 * simply loses its thread reference and keeps consuming credits. We therefore
 * follow the order: stop related schedules, cancel related active runs, then
 * delete the thread.
 *
 * Run cancellation has side effects that cannot participate in the thread's
 * delete transaction (`cancelRun$` opens its own transaction and the runner
 * must be notified), so ownership is verified up front and the cancelled-run
 * results are returned for the caller to dispatch the post-cancel side effects.
 */
export const deleteChatThread$ = command(
  async (
    { set },
    args: { readonly threadId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const writeDb = set(writeDb$);

    const [ownedThread] = await writeDb
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!ownedThread) {
      return { deleted: false, cancelledRuns: [] };
    }

    // Stop related automations first so none of them can spawn a fresh run
    // while we are cancelling the in-flight ones (their triggers cascade).
    await writeDb
      .delete(automations)
      .where(eq(automations.chatThreadId, ownedThread.id));
    signal.throwIfAborted();

    // Cancel related active runs. Terminal runs (completed/failed/cancelled)
    // are left untouched; only queued/pending/running runs need stopping.
    const activeRuns = await writeDb
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
    signal.throwIfAborted();

    const cancelledRuns: CancelRunResult[] = [];
    for (const run of activeRuns) {
      const result = await set(
        cancelRun$,
        { runId: run.runId, userId: args.userId, orgId: run.orgId },
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

    // Delete the thread last. Cascades chat_messages; the now-cancelled runs
    // have their zero_runs.chatThreadId set to NULL.
    const [deletedThread] = await writeDb
      .delete(chatThreads)
      .where(eq(chatThreads.id, ownedThread.id))
      .returning({ id: chatThreads.id });
    signal.throwIfAborted();

    return { deleted: Boolean(deletedThread), cancelledRuns };
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
      readonly draftContent: string | null;
      readonly draftAttachments: readonly PersistedAttachment[] | null;
    },
    signal: AbortSignal,
  ): Promise<{ readonly updated: boolean }> => {
    const writeDb = set(writeDb$);

    const updated = await writeDb
      .update(chatThreads)
      .set({
        draftContent: args.draftContent,
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
