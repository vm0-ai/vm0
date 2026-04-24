import { eq, and, desc, inArray, isNull, sql, or, lt } from "drizzle-orm";
import { chatThreads } from "../../../db/schema/chat-thread";
import { chatMessages } from "../../../db/schema/chat-message";
import { zeroRuns } from "../../../db/schema/zero-run";
import { agentRuns } from "../../../db/schema/agent-run";
import { zeroAgents } from "../../../db/schema/zero-agent";
import { notFound } from "../../shared/errors";
import {
  getMessagesByThreadId,
  getLatestSessionIdForThread,
  publishThreadListChanged,
} from "./chat-message-service";
import { formatChatRunErrorMessage } from "./chat-run-error-message";
import {
  type PersistedAttachment,
  type ResolvedAttachFile,
  persistedAttachmentSchema,
} from "@vm0/core/contracts/chat-threads";
import { listS3Objects } from "../../infra/s3/s3-client";
import { env } from "../../../env";
import { EXT_MIMETYPE_MAP } from "../../shared/mimetype";
import { buildFileUrl } from "../uploads/file-url";

/**
 * Create a new chat thread.
 */
export async function createChatThread(
  userId: string,
  agentComposeId: string,
  title?: string | null,
): Promise<{ id: string; createdAt: Date }> {
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({
      userId,
      agentComposeId,
      title: title ?? null,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });

  if (!thread) {
    throw new Error("Failed to create chat thread");
  }

  return thread;
}

/**
 * List chat threads for a user, ordered by the latest message's createdAt desc
 * (threads with no messages fall back to the thread's own createdAt). This
 * reflects real conversation activity — `chat_threads.updatedAt` only changes
 * on title/draft edits, not on new messages, so sorting by it would bury
 * actively-used threads.
 *
 * When `agentComposeId` is supplied, filters to that agent. Otherwise returns
 * every thread the user owns within `orgId` (cross-org isolation enforced in
 * SQL via the `zero_agents.org_id` join predicate).
 *
 * Joins each thread to its most recent message and returns that message's
 * read/archive state. Threads whose last message is archived are hidden
 * (user intent: archiving the last message dismisses the thread from the
 * list). Threads with no messages yet are kept (last-message columns null).
 *
 * Each row also carries the owning agent's id and avatar_url so the unified
 * view can render per-row avatars without an extra client lookup.
 */
export async function listChatThreads(
  userId: string,
  orgId: string,
  agentComposeId?: string,
): Promise<
  Array<{
    id: string;
    title: string | null;
    agentId: string;
    agentAvatarUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
    isRead: boolean;
    lastMessageArchivedAt: Date | null;
    running: boolean;
  }>
> {
  const lastMessage = globalThis.services.db
    .select({
      chatThreadId: chatMessages.chatThreadId,
      createdAt: chatMessages.createdAt,
      archivedAt: chatMessages.archivedAt,
      rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${chatMessages.chatThreadId} ORDER BY ${chatMessages.createdAt} DESC)`.as(
        "rn",
      ),
    })
    .from(chatMessages)
    .as("last_message");

  const filters = [
    eq(chatThreads.userId, userId),
    eq(zeroAgents.orgId, orgId),
    isNull(lastMessage.archivedAt),
  ];
  if (agentComposeId) {
    filters.push(eq(chatThreads.agentComposeId, agentComposeId));
  }

  const threads = await globalThis.services.db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      agentId: chatThreads.agentComposeId,
      agentAvatarUrl: zeroAgents.avatarUrl,
      createdAt: chatThreads.createdAt,
      updatedAt: chatThreads.updatedAt,
      isRead: sql<boolean>`CASE
        WHEN ${lastMessage.createdAt} IS NULL THEN true
        WHEN ${chatThreads.lastReadAt} IS NULL THEN false
        ELSE ${chatThreads.lastReadAt} >= ${lastMessage.createdAt}
      END`,
      lastMessageArchivedAt: lastMessage.archivedAt,
      running: sql<boolean>`EXISTS (
        SELECT 1
        FROM ${zeroRuns}
        INNER JOIN ${agentRuns} ON ${agentRuns.id} = ${zeroRuns.id}
        WHERE ${zeroRuns.chatThreadId} = ${chatThreads.id}
          AND ${agentRuns.status} IN ('queued', 'pending', 'running')
      )`,
    })
    .from(chatThreads)
    .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
    .leftJoin(
      lastMessage,
      and(eq(lastMessage.chatThreadId, chatThreads.id), eq(lastMessage.rn, 1)),
    )
    .where(and(...filters))
    .orderBy(
      desc(sql`COALESCE(${lastMessage.createdAt}, ${chatThreads.createdAt})`),
    );

  return threads;
}

/**
 * Advance the read cursor for a thread to `cursor` (default: server NOW()).
 * Forward-only: if the stored cursor is already >= cursor, it is not rewound.
 * Always returns the current `last_read_at` value after the operation.
 */
export async function markThreadRead(
  userId: string,
  threadId: string,
  cursor?: Date,
): Promise<Date> {
  const effectiveCursor = cursor
    ? new Date(Math.min(cursor.getTime(), Date.now()))
    : new Date();

  const [updated] = await globalThis.services.db
    .update(chatThreads)
    .set({ lastReadAt: effectiveCursor })
    .where(
      and(
        eq(chatThreads.id, threadId),
        eq(chatThreads.userId, userId),
        or(
          isNull(chatThreads.lastReadAt),
          lt(chatThreads.lastReadAt, effectiveCursor),
        ),
      ),
    )
    .returning({ lastReadAt: chatThreads.lastReadAt });

  if (updated?.lastReadAt) {
    return updated.lastReadAt;
  }

  // Guard rejected (cursor didn't advance) — return current value
  const [current] = await globalThis.services.db
    .select({ lastReadAt: chatThreads.lastReadAt })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!current) {
    throw notFound("Chat thread not found");
  }

  return current.lastReadAt ?? new Date(0);
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
  selectedModel: string | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const [thread] = await globalThis.services.db
    .select()
    .from(chatThreads)
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
    modelProviderId: thread.modelProviderId ?? null,
    selectedModel: thread.selectedModel ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Update a chat thread's draft content and attachments.
 * Ownership check in WHERE clause ensures users can only update their own threads.
 */
export async function updateChatThreadDraft(
  threadId: string,
  userId: string,
  draftContent: string | null,
  draftAttachments: PersistedAttachment[] | null,
): Promise<void> {
  const updated = await globalThis.services.db
    .update(chatThreads)
    .set({ draftContent, draftAttachments })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (updated.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Delete a chat thread with ownership check.
 * Cascade deletes handle chat_messages cleanup.
 */
export async function deleteChatThread(
  threadId: string,
  userId: string,
): Promise<void> {
  const deleted = await globalThis.services.db
    .delete(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (deleted.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Update a chat thread's title.
 */
export async function updateChatThreadTitle(
  threadId: string,
  userId: string,
  title: string,
): Promise<void> {
  await globalThis.services.db
    .update(chatThreads)
    .set({ title })
    .where(eq(chatThreads.id, threadId));
  await publishThreadListChanged(userId);
}

type ChatMessage = {
  role: "user" | "assistant";
  content: string | null;
  runId?: string;
  error?: string;
  status?: string;
  attachFiles?: ResolvedAttachFile[];
  createdAt: string;
};

/**
 * Resolve file IDs to permanent file URLs with metadata for the frontend.
 *
 * Lists S3 objects at each file's prefix to recover filename and size, then
 * constructs the permanent `${APP_URL}/f/{userId}/{id}/{filename}` URL. The
 * short-lived presigned signature is materialized per-request inside the /f
 * route, not here — the value returned to the frontend is stable and safe
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

      return {
        role: row.role as "user" | "assistant",
        content: row.content,
        runId: row.runId ?? undefined,
        error: effectiveError,
        status: row.runStatus ?? undefined,
        attachFiles,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );

  return {
    chatMessages,
    latestSessionId: latestSessionId ?? null,
  };
}

/**
 * Return non-terminal runs for this thread with live status. The UI uses
 * `status` to distinguish queued from running so it can show "Waiting in
 * queue" without a second API round-trip.
 */
export async function getActiveRunsForThread(
  threadId: string,
): Promise<{ id: string; status: string }[]> {
  return globalThis.services.db
    .select({ id: zeroRuns.id, status: agentRuns.status })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        inArray(agentRuns.status, ["queued", "pending", "running"]),
      ),
    );
}
