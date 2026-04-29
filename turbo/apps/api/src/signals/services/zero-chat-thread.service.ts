import { computed, type Computed } from "ccstate";
import {
  type ChatThreadDetail,
  type PagedChatMessage,
  type PersistedAttachment,
  type ResolvedAttachFile,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import { modelProviderTypeSchema } from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { listS3Objects } from "../external/s3";

const REPORT_ERROR_STREAK_THRESHOLD = 2;

const CHAT_RUN_TRANSIENT_ERROR_MESSAGE =
  "Oops, something went wrong. Please try again later.";
const CHAT_RUN_REPORTABLE_ERROR_MESSAGE = "An unexpected error occurred.";

const ACTIONABLE_ERROR_SNIPPETS = [
  ...Object.values(RUN_ERROR_GUIDANCE).flatMap((guidance) => {
    return [guidance.title, guidance.guidance];
  }),
  "Cannot continue session",
  "Invalid signature in thinking block",
  "Run cancelled",
] as const;

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
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly runStatus: string | null;
  readonly runError: string | null;
  readonly attachFiles: readonly string[] | null;
};

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentComposeId: string;
  readonly draftContent: string | null;
  readonly draftAttachments: readonly PersistedAttachment[] | null;
  readonly modelProviderId: string | null;
  readonly selectedModel: string | null;
  readonly lastReadMessageId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const messageColumns = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  runId: chatMessages.runId,
  error: chatMessages.error,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  runStatus: agentRuns.status,
  runError: agentRuns.error,
  attachFiles: chatMessages.attachFiles,
} as const;

function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext
    ? (EXT_MIMETYPE_MAP[ext] ?? "application/octet-stream")
    : "application/octet-stream";
}

function buildFileUrl(userId: string, id: string, filename: string): string {
  const baseUrl = env("VM0_API_URL") ?? "http://localhost:3000";
  return `${baseUrl}/f/${encodeURIComponent(userId)}/${id}/${encodeURIComponent(filename)}`;
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

function isActionableRunError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return ACTIONABLE_ERROR_SNIPPETS.some((snippet) => {
    return normalized.includes(snippet.toLowerCase());
  });
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
      .select()
      .from(chatThreads)
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
      modelProviderId: thread.modelProviderId ?? null,
      selectedModel: thread.selectedModel ?? null,
      lastReadMessageId: thread.lastReadMessageId ?? null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  });
}

function resolveAttachFileUrls(
  userId: string,
  fileIds: readonly string[],
): Computed<Promise<readonly ResolvedAttachFile[]>> {
  return computed(async (get): Promise<readonly ResolvedAttachFile[]> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return [];
    }
    const resolved = await Promise.all(
      fileIds.map(async (fileId): Promise<ResolvedAttachFile | null> => {
        const prefix = `uploads/${userId}/${fileId}/`;
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

function formatChatRunErrorMessage(params: {
  readonly chatThreadId: string;
  readonly runId: string;
  readonly errorMessage: string;
}): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const errorMessage = params.errorMessage.trim() || "Run failed";

    if (isActionableRunError(errorMessage)) {
      return errorMessage;
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
      : CHAT_RUN_TRANSIENT_ERROR_MESSAGE;
  });
}

function toStoredMessage(
  threadId: string,
  userId: string,
  row: ChatMessageRow,
): Computed<Promise<ChatThreadDetail["chatMessages"][number]>> {
  return computed(
    async (get): Promise<ChatThreadDetail["chatMessages"][number]> => {
      const isPlaceholder = row.sequenceNumber === null;
      const rawEffectiveError = isPlaceholder
        ? (row.error ?? row.runError ?? undefined)
        : (row.error ?? undefined);
      const effectiveError =
        rawEffectiveError && isPlaceholder && !row.error && row.runId
          ? await get(
              formatChatRunErrorMessage({
                chatThreadId: threadId,
                runId: row.runId,
                errorMessage: rawEffectiveError,
              }),
            )
          : rawEffectiveError;
      const attachFiles =
        row.attachFiles && row.attachFiles.length > 0
          ? await get(resolveAttachFileUrls(userId, row.attachFiles))
          : undefined;

      return {
        role: messageRoleSchema.parse(row.role),
        content: row.content,
        runId: row.runId ?? undefined,
        error: effectiveError,
        status: row.runStatus ?? undefined,
        attachFiles: attachFiles ? [...attachFiles] : undefined,
        createdAt: row.createdAt.toISOString(),
      };
    },
  );
}

function toPagedMessage(
  threadId: string,
  userId: string,
  row: ChatMessageRow,
): Computed<Promise<PagedChatMessage>> {
  return computed(async (get): Promise<PagedChatMessage> => {
    const isLegacyPlaceholder =
      row.sequenceNumber === null && row.content === null && !row.error;
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
    const attachFiles =
      row.attachFiles && row.attachFiles.length > 0
        ? await get(resolveAttachFileUrls(userId, row.attachFiles))
        : undefined;

    return {
      id: row.id,
      role: messageRoleSchema.parse(row.role),
      content: row.content,
      runId: row.runId ?? undefined,
      error: effectiveError,
      status: row.runStatus ?? undefined,
      attachFiles: attachFiles ? [...attachFiles] : undefined,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

function chatThreadMessages(
  threadId: string,
  userId: string,
): Computed<Promise<readonly ChatThreadDetail["chatMessages"][number][]>> {
  return computed(
    async (
      get,
    ): Promise<readonly ChatThreadDetail["chatMessages"][number][]> => {
      const rows = await get(db$)
        .select(messageColumns)
        .from(chatMessages)
        .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
        .where(eq(chatMessages.chatThreadId, threadId))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));

      return await Promise.all(
        rows.map((row) => {
          return get(toStoredMessage(threadId, userId, row));
        }),
      );
    },
  );
}

function latestSessionIdForThread(
  threadId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const rows = await get(db$)
      .select({
        result: agentRuns.result,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(zeroRuns.chatThreadId, threadId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(5);

    for (const row of rows) {
      if (hasAgentSessionId(row.result)) {
        return row.result.agentSessionId;
      }
    }
    return null;
  });
}

function latestRunProviderTypeForThread(
  threadId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const [row] = await get(db$)
      .select({ modelProvider: zeroRuns.modelProvider })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
      .where(eq(zeroRuns.chatThreadId, threadId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    return row?.modelProvider ?? null;
  });
}

function activeRunsForThread(
  threadId: string,
): Computed<
  Promise<readonly { readonly id: string; readonly status: string }[]>
> {
  return computed(
    async (
      get,
    ): Promise<readonly { readonly id: string; readonly status: string }[]> => {
      return await get(db$)
        .select({ id: zeroRuns.id, status: agentRuns.status })
        .from(zeroRuns)
        .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
        .where(
          and(
            eq(zeroRuns.chatThreadId, threadId),
            inArray(agentRuns.status, ["queued", "pending", "running"]),
          ),
        );
    },
  );
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

    const [messages, activeRuns, latestSessionId, latestRunProviderTypeRaw] =
      await Promise.all([
        get(chatThreadMessages(args.threadId, args.userId)),
        get(activeRunsForThread(args.threadId)),
        get(latestSessionIdForThread(args.threadId)),
        get(latestRunProviderTypeForThread(args.threadId)),
      ]);

    return {
      id: thread.id,
      title: thread.title,
      agentId: thread.agentComposeId,
      chatMessages: [...messages],
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
      modelProviderId: thread.modelProviderId,
      selectedModel: thread.selectedModel,
    };
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
        .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
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
          .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
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
          .leftJoin(agentRuns, eq(chatMessages.runId, agentRuns.id))
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
