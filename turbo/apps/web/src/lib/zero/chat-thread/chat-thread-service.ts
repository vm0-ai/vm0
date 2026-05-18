import { eq, and } from "drizzle-orm";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { notFound } from "@vm0/api-services/errors";
import {
  getMessagesByThreadId,
  getLatestSessionIdForThread,
  publishThreadListChanged,
} from "./chat-message-service";
import { formatChatRunErrorMessage } from "./chat-run-error-message";
import {
  type ChatThreadDetail,
  type PersistedAttachment,
  type ResolvedAttachFile,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import { listS3Objects } from "../../infra/s3/s3-client";
import { env } from "../../../env";
import { EXT_MIMETYPE_MAP } from "../../shared/mimetype";
import { buildFileUrl } from "../uploads/file-url";

/**
 * Create a new chat thread.
 *
 * `pin`: when provided, stores only the selected model on the thread. Provider
 * routing is intentionally re-resolved from the current org policy for each run.
 */
export async function createChatThread(
  userId: string,
  agentComposeId: string,
  title?: string | null,
  id?: string,
  pin?: {
    modelProviderId: string | null;
    modelProviderType?: string | null;
    modelProviderCredentialScope?: string | null;
    selectedModel: string | null;
  },
): Promise<{ id: string; createdAt: Date }> {
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({
      ...(id ? { id } : {}),
      userId,
      agentComposeId,
      title: title ?? null,
      modelProviderId: null,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: pin?.selectedModel ?? null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });

  if (!thread) {
    throw new Error("Failed to create chat thread");
  }

  return thread;
}

/**
 * Get a chat thread by ID with ownership check.
 */
export async function getChatThread(
  threadId: string,
  userId: string,
): Promise<{
  id: string;
  title: string | null;
  agentComposeId: string;
  draftContent: string | null;
  draftAttachments: PersistedAttachment[] | null;
  modelProviderId: string | null;
  modelProviderType: string | null;
  modelProviderCredentialScope: string | null;
  selectedModel: string | null;
  orgId: string | null;
  lastReadMessageId: string | null;
  renamedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const [thread] = await globalThis.services.db
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
    throw notFound("Chat thread not found");
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
}

/**
 * Update a chat thread's title.
 */
export async function updateChatThreadTitle(
  threadId: string,
  userId: string,
  title: string,
): Promise<void> {
  const [thread] = await globalThis.services.db
    .select({ renamedAt: chatThreads.renamedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  if (thread?.renamedAt) {
    return;
  }

  await globalThis.services.db
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId));
  await publishThreadListChanged(userId);
}

type ChatMessage = ChatThreadDetail["chatMessages"][number];

function chatMessageStatus(row: {
  role: string;
  runStatus: string | null;
}): string | undefined {
  if (row.role !== "assistant") {
    return undefined;
  }
  return row.runStatus ?? undefined;
}

/**
 * Resolve file IDs to permanent file URLs with metadata for the frontend.
 *
 * Lists S3 objects at each file's prefix to recover filename and size, then
 * constructs the permanent `${APP_URL}/f/{publicUserId}/{id}/{filename}` URL.
 * The short-lived presigned signature is materialized per-request inside the
 * /f route, not here — the value returned to the frontend is stable and safe
 * to persist in markdown or share over external channels.
 */
export async function resolveAttachFileUrls(
  userId: string,
  fileIds: string[],
): Promise<ResolvedAttachFile[]> {
  const bucket = env().R2_USER_STORAGES_BUCKET_NAME;
  const results = await Promise.all(
    fileIds.map(async (fileId) => {
      const prefix = `uploads/${userId}/${fileId}/`;
      const objects = await listS3Objects(bucket, prefix);
      if (objects.length === 0) {
        return null;
      }
      const obj = objects[0]!;
      const filename = obj.key.split("/").pop() ?? fileId;
      const ext = filename.split(".").pop()?.toLowerCase();
      const contentType =
        (ext ? EXT_MIMETYPE_MAP[ext] : undefined) ?? "application/octet-stream";
      const url = buildFileUrl(userId, fileId, filename);
      return { id: fileId, filename, contentType, size: obj.size, url };
    }),
  );
  return results.filter((r): r is ResolvedAttachFile => {
    return r !== null;
  });
}

export async function getChatThreadMessages(
  threadId: string,
  userId: string,
): Promise<{
  chatMessages: ChatMessage[];
  latestSessionId: string | null;
}> {
  const [rows, latestSessionId] = await Promise.all([
    getMessagesByThreadId(threadId),
    getLatestSessionIdForThread(threadId),
  ]);

  const chatMessages: ChatMessage[] = await Promise.all(
    rows.map(async (row) => {
      // Event-backed rows (sequence_number set) carry their own valid assistant
      // text — they must never inherit the run-level error via the leftJoin,
      // or a timed-out run would mask every intermediate message as "failed".
      // The placeholder row (sequence_number IS NULL) is the only row that
      // falls back to agent_runs.error, covering the case where the terminal
      // callback failed to deliver and chat_messages.error was never written.
      const isPlaceholder = row.sequenceNumber === null;
      const rawEffectiveError = isPlaceholder
        ? (row.error ?? row.runError ?? undefined)
        : (row.error ?? undefined);
      const effectiveError =
        rawEffectiveError && isPlaceholder && !row.error && row.runId
          ? await formatChatRunErrorMessage({
              chatThreadId: threadId,
              runId: row.runId,
              errorMessage: rawEffectiveError,
            })
          : rawEffectiveError;

      const attachFiles =
        row.attachFiles && row.attachFiles.length > 0
          ? await resolveAttachFileUrls(userId, row.attachFiles)
          : undefined;

      const role = row.role as "user" | "assistant";
      const message = {
        id: row.id,
        role,
        content: row.content,
        runId: row.runId ?? undefined,
        revokesMessageId: row.revokesMessageId ?? undefined,
        interruptsRunId: row.interruptsRunId ?? undefined,
        error: effectiveError,
        attachFiles,
        createdAt: row.createdAt.toISOString(),
      };
      if (role !== "assistant") {
        return {
          ...message,
          role: "user" as const,
        };
      }
      return {
        ...message,
        role: "assistant" as const,
        status: chatMessageStatus(row),
      };
    }),
  );

  return {
    chatMessages,
    latestSessionId: latestSessionId ?? null,
  };
}
