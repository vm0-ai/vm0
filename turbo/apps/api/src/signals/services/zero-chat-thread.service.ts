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
  formatRunErrorForExternalSurface,
  isActionableRunError,
  isGenericRunErrorForDisplay,
} from "@vm0/api-contracts/contracts/errors";
import { modelProviderTypeSchema } from "@vm0/api-contracts/contracts/model-providers";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageRecommendedFollowupGenerationType,
  type ChatMessageRecommendedFollowups,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroAgentSchedules } from "@vm0/db/schema/zero-agent-schedule";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
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
  readonly error: string | null;
  readonly runLifecycleEvent: string | null;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly runStatus: string | null;
  readonly runError: string | null;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly recommendedFollowups: ChatMessageRecommendedFollowups | null;
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
  readonly orgId: string | null;
  readonly lastReadMessageId: string | null;
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
 * pulling a thread back down the sidebar. Call inside the same transaction as
 * the chat_messages insert so the recency index stays accurate.
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
  error: chatMessages.error,
  runLifecycleEvent: chatMessages.runLifecycleEvent,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  runStatus: agentRuns.status,
  runError: agentRuns.error,
  attachFiles: chatMessages.attachFiles,
  attachFileMetadata: chatMessages.attachFileMetadata,
  generationTemplate: chatMessages.generationTemplate,
  recommendedFollowups: chatMessages.recommendedFollowups,
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

function hasAgentSessionId(
  value: unknown,
): value is { readonly agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { readonly agentSessionId: unknown }).agentSessionId ===
      "string"
  );
}

function buildReportableErrorMessage(runId: string): string {
  return `${CHAT_RUN_REPORTABLE_ERROR_MESSAGE} [Report this issue](/runs/${encodeURIComponent(runId)}/report-error)`;
}

function formatLatestSessionProviderType(
  value: string | null,
): ChatThreadDetail["latestSessionProviderType"] {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderTypeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
        selectedModel: chatThreads.selectedModel,
        orgId: zeroAgents.orgId,
        lastReadMessageId: chatThreads.lastReadMessageId,
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
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: thread.selectedModel ?? null,
      orgId: thread.orgId ?? null,
      lastReadMessageId: thread.lastReadMessageId ?? null,
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

function chatMessageStatus(row: ChatMessageRow): string | undefined {
  if (row.role !== "assistant") {
    return undefined;
  }
  return row.runStatus ?? undefined;
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

function toPagedMessage(
  threadId: string,
  userId: string,
  row: ChatMessageRow,
): Computed<Promise<PagedChatMessage>> {
  return computed(async (get): Promise<PagedChatMessage> => {
    const isLifecycleMarker = row.runLifecycleEvent !== null;
    const isLegacyPlaceholder =
      !isLifecycleMarker &&
      row.sequenceNumber === null &&
      row.content === null &&
      !row.error;
    const rawEffectiveError = isLegacyPlaceholder
      ? (row.runError ?? undefined)
      : (row.error ?? undefined);
    const effectiveError =
      rawEffectiveError && isLegacyPlaceholder && row.runId
        ? await get(
            formatChatRunErrorMessage({
              chatThreadId: threadId,
              runId: row.runId,
              errorMessage: rawEffectiveError,
            }),
          )
        : rawEffectiveError;
    const attachFiles = await get(chatMessageAttachFiles(userId, row));

    const role = messageRoleSchema.parse(row.role);
    const message = {
      id: row.id,
      role,
      content: row.content,
      runId: row.runId ?? undefined,
      revokesMessageId: row.revokesMessageId ?? undefined,
      interruptsRunId: row.interruptsRunId ?? undefined,
      error: effectiveError,
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
      };
    }
    return {
      ...message,
      role: "assistant" as const,
      status: chatMessageStatus(row),
      runLifecycleEvent: lifecycleEventOrUndefined(row.runLifecycleEvent),
      recommendedFollowups: normalizeRecommendedFollowups(
        row.recommendedFollowups,
      ),
    };
  });
}

// Single zero_runs JOIN agent_runs scan used to derive activeRuns,
// latestSessionId, and latestRunProviderType in JS. Replaces three near-
// identical queries that each paid the same join cost on the hot
// chat-thread detail path. Rows are ordered newest-first so the latest-N
// scans below match the previous LIMIT semantics.
const LATEST_SESSION_ID_SCAN_DEPTH = 5;

function isActiveRunStatus(status: string): boolean {
  return status === "queued" || status === "pending" || status === "running";
}

interface ThreadRunSummaryRow {
  readonly id: string;
  readonly modelProvider: string | null;
  readonly status: string;
  readonly result: unknown;
}

function threadRunSummaries(
  threadId: string,
): Computed<Promise<readonly ThreadRunSummaryRow[]>> {
  return computed(async (get): Promise<readonly ThreadRunSummaryRow[]> => {
    return await get(db$)
      .select({
        id: zeroRuns.id,
        modelProvider: zeroRuns.modelProvider,
        status: agentRuns.status,
        result: agentRuns.result,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(zeroRuns.chatThreadId, threadId))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id));
  });
}

function pickActiveRuns(
  rows: readonly ThreadRunSummaryRow[],
): readonly { readonly id: string; readonly status: string }[] {
  const active: { id: string; status: string }[] = [];
  for (const row of rows) {
    if (isActiveRunStatus(row.status)) {
      active.push({ id: row.id, status: row.status });
    }
  }
  return active;
}

function pickLatestSessionId(
  rows: readonly ThreadRunSummaryRow[],
): string | null {
  const limit = Math.min(rows.length, LATEST_SESSION_ID_SCAN_DEPTH);
  for (let i = 0; i < limit; i++) {
    const row = rows[i]!;
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return null;
}

function pickLatestRunProviderType(
  rows: readonly ThreadRunSummaryRow[],
): string | null {
  return rows[0]?.modelProvider ?? null;
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
    const activeRuns = pickActiveRuns(runSummaries);
    const latestSessionId = pickLatestSessionId(runSummaries);
    const latestRunProviderTypeRaw = pickLatestRunProviderType(runSummaries);

    return {
      id: thread.id,
      title: thread.title,
      agentId: thread.agentComposeId,
      latestSessionId,
      lastReadMessageId: thread.lastReadMessageId,
      latestSessionProviderType: formatLatestSessionProviderType(
        latestRunProviderTypeRaw,
      ),
      activeRunIds: activeRuns.map((run) => {
        return run.id;
      }),
      activeRuns: [...activeRuns],
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
  readonly totalCount: number;
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

type LastMessageSubquery = ReturnType<typeof lastVisibleMessageSubquery>;

function chatThreadListProjection(lastMessage: LastMessageSubquery) {
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
    isRead: sql<boolean>`CASE
      WHEN ${lastMessage.id} IS NULL THEN true
      ELSE COALESCE(${chatThreads.lastReadMessageId} = ${lastMessage.id}, false)
    END`,
    running: sql<boolean>`EXISTS (
      SELECT 1
      FROM ${zeroRuns}
      INNER JOIN ${agentRuns} ON ${agentRuns.id} = ${zeroRuns.id}
      WHERE ${zeroRuns.chatThreadId} = ${chatThreads.id}
        AND ${agentRuns.status} IN ('queued', 'pending', 'running')
    )`,
    hasDraft: sql<boolean>`(
      COALESCE(${chatThreads.draftContent}, '') <> ''
      OR (
        ${chatThreads.draftAttachments} IS NOT NULL
        AND jsonb_array_length(${chatThreads.draftAttachments}) > 0
      )
    )`,
    scheduleCount: sql<number>`(
      SELECT COUNT(*)::int
      FROM ${zeroAgentSchedules}
      WHERE ${zeroAgentSchedules.chatThreadId} = ${chatThreads.id}
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
  readonly isRead: boolean;
  readonly running: boolean;
  readonly hasDraft: boolean;
  readonly scheduleCount: number;
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
    isRead: thread.isRead,
    running: thread.running,
    hasDraft: thread.hasDraft,
    scheduleCount: thread.scheduleCount,
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

    const lastMessage = lastVisibleMessageSubquery(db);
    const projection = chatThreadListProjection(lastMessage);

    const scopedFilters = [
      eq(chatThreads.userId, args.userId),
      eq(zeroAgents.orgId, args.orgId),
    ];
    if (args.agentComposeId) {
      scopedFilters.push(eq(chatThreads.agentComposeId, args.agentComposeId));
    }

    // Pinned segment is only returned on the first page (no cursor).
    // Honours the same agent scope as the non-pinned segment so the sidebar
    // never surfaces another agent's pinned threads while you're viewing one.
    const pinnedRows = cursor
      ? []
      : await db
          .select(projection)
          .from(chatThreads)
          .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
          .leftJoinLateral(lastMessage, sql`true`)
          .where(and(...scopedFilters, isNotNull(chatThreads.pinnedAt)))
          .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id));

    const nonPinnedFilters = [...scopedFilters, isNull(chatThreads.pinnedAt)];
    if (cursor) {
      nonPinnedFilters.push(cursorAdvanceFilter(cursor));
    }

    const nonPinnedRows = await db
      .select(projection)
      .from(chatThreads)
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .leftJoinLateral(lastMessage, sql`true`)
      .where(and(...nonPinnedFilters))
      .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
      .limit(limit + 1);

    const hasMore = nonPinnedRows.length > limit;
    const pageRows = hasMore ? nonPinnedRows.slice(0, limit) : nonPinnedRows;
    const lastRow = hasMore ? pageRows[pageRows.length - 1] : undefined;
    const nextCursor = lastRow
      ? encodeChatThreadListCursor({
          lastMessageAt: lastRow.lastMessageAt,
          id: lastRow.id,
        })
      : null;

    const [countRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(chatThreads)
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .where(and(...scopedFilters, isNull(chatThreads.pinnedAt)));

    return {
      pinned: pinnedRows.map(rowToChatThreadListItem),
      threads: pageRows.map(rowToChatThreadListItem),
      hasMore,
      nextCursor,
      totalCount: countRow?.count ?? 0,
    };
  });
}

export function ownedChatThreadById(args: {
  readonly threadId: string;
  readonly userId: string;
}): Computed<Promise<{ readonly id: string } | null>> {
  return computed(async (get): Promise<{ readonly id: string } | null> => {
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);

    return thread ?? null;
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

      const hostedSiteRunIds = new Set(
        rows
          .filter((row) => {
            return row.metadata.artifactKind === "hosted-site";
          })
          .map((row) => {
            return row.runId;
          }),
      );
      const visibleRows = rows.filter((row) => {
        return (
          !hostedSiteRunIds.has(row.runId) ||
          row.metadata.artifactKind === "hosted-site"
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
        existing.files.push({
          id: row.externalId,
          filename,
          contentType: row.contentType ?? inferMimetype(filename),
          size: row.sizeBytes ?? 0,
          url: row.url,
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
        .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
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
          .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
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
          .leftJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
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
          return get(toPagedMessage(args.threadId, args.userId, row));
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
      })
      .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
    signal.throwIfAborted();

    if (!thread) {
      throw new Error("Failed to create chat thread");
    }

    return thread;
  },
);

export const insertIntegrationChatMessage$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly content: string;
    },
    signal: AbortSignal,
  ): Promise<{ readonly id: string; readonly createdAt: Date }> => {
    const writeDb = set(writeDb$);
    const [message] = await writeDb
      .insert(chatMessages)
      .values({
        chatThreadId: args.chatThreadId,
        role: "assistant",
        content: args.content,
        runId: null,
      })
      .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
    signal.throwIfAborted();

    if (!message) {
      throw new Error("Failed to insert chat message");
    }

    await touchChatThreadLastMessageAt(writeDb, args.chatThreadId);
    signal.throwIfAborted();

    await publishUserSignal(
      [args.userId],
      `chatThreadMessageCreated:${args.chatThreadId}`,
    );
    signal.throwIfAborted();

    await publishThreadListChanged(args.userId);
    signal.throwIfAborted();

    return message;
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
      await touchChatThreadLastMessageAt(writeDb, args.threadId);
      signal.throwIfAborted();

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

export const deleteChatThread$ = command(
  async (
    { set },
    args: { readonly threadId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<{ deleted: boolean }> => {
    const writeDb = set(writeDb$);
    const deleted = await writeDb.transaction(async (tx) => {
      const [ownedThread] = await tx
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.id, args.threadId),
            eq(chatThreads.userId, args.userId),
          ),
        )
        .limit(1);
      if (!ownedThread) {
        return false;
      }

      await tx
        .delete(zeroAgentSchedules)
        .where(eq(zeroAgentSchedules.chatThreadId, ownedThread.id));

      const deletedThreads = await tx
        .delete(chatThreads)
        .where(eq(chatThreads.id, ownedThread.id))
        .returning({ id: chatThreads.id });
      return deletedThreads.length > 0;
    });
    signal.throwIfAborted();
    return { deleted };
  },
);

/**
 * A thread "has a draft" when its draft text is non-empty OR it has at least
 * one attachment. Mirrors web's `hasDraftValue` helper exactly so the
 * conditional `threadListChanged` publish observable from web is preserved
 * bit-for-bit.
 */
function hasDraftValue(
  content: string | null,
  attachments: readonly PersistedAttachment[] | null,
): boolean {
  return (
    (content !== null && content !== "") ||
    (attachments !== null && attachments.length > 0)
  );
}

/**
 * Update a chat thread's draft content + attachments.
 *
 * Ownership check via the WHERE clause; missing or cross-user thread → returns
 * `{ updated: false }` so the route handler emits the correct 404. Publishes
 * `threadListChanged` only when the boolean `hasDraft` flag flips, so that
 * continued typing inside an already-drafting thread does not spam the
 * sidebar — same behaviour as web's `updateChatThreadDraft`.
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

    const [before] = await writeDb
      .select({
        draftContent: chatThreads.draftContent,
        draftAttachments: chatThreads.draftAttachments,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!before) {
      return { updated: false };
    }

    await writeDb
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
      );
    signal.throwIfAborted();

    const hadDraft = hasDraftValue(
      before.draftContent,
      before.draftAttachments as PersistedAttachment[] | null,
    );
    const hasDraft = hasDraftValue(args.draftContent, args.draftAttachments);
    if (hadDraft !== hasDraft) {
      await publishThreadListChanged(args.userId);
      signal.throwIfAborted();
    }

    return { updated: true };
  },
);
