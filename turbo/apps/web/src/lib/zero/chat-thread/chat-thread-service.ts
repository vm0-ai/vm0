import {
  eq,
  and,
  desc,
  inArray,
  isNull,
  asc,
  or,
  sql,
  isNotNull,
} from "drizzle-orm";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { notFound } from "@vm0/api-services/errors";
import {
  getMessagesByThreadId,
  getLatestSessionIdForThread,
  publishThreadListChanged,
} from "./chat-message-service";
import { formatChatRunErrorMessage } from "./chat-run-error-message";
import {
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type PersistedAttachment,
  type ResolvedAttachFile,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import { listS3Objects } from "../../infra/s3/s3-client";
import { env } from "../../../env";
import { EXT_MIMETYPE_MAP } from "../../shared/mimetype";
import { buildFileUrl } from "../uploads/file-url";

function visibleChatMessageCondition() {
  return sql<boolean>`NOT EXISTS (
      SELECT 1
      FROM ${chatMessages} AS revoker
      WHERE revoker.revokes_message_id = ${chatMessages.id}
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.revokesMessageId} IS NOT NULL
    )
    AND NOT (
      ${chatMessages.role} = 'user'
      AND ${chatMessages.runId} IS NULL
      AND ${chatMessages.interruptsRunId} IS NOT NULL
    )`;
}

/**
 * Create a new chat thread.
 *
 * `pin`: when provided, eager-pins the thread to a specific model provider /
 * selected-model combination at insert time so subsequent runs stay on the
 * thread's first effective model. Omitting `pin` (or passing both fields as
 * null) leaves the row unpinned so the caller can resolve from user preference
 * and workspace default policy.
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
      modelProviderId: pin?.modelProviderId ?? null,
      modelProviderType: pin?.modelProviderType ?? null,
      modelProviderCredentialScope: pin?.modelProviderCredentialScope ?? null,
      selectedModel: pin?.selectedModel ?? null,
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
    pinnedAt: Date | null;
    renamedAt: Date | null;
    isRead: boolean;
    lastMessageArchivedAt: Date | null;
    running: boolean;
    hasDraft: boolean;
  }>
> {
  const lastMessage = globalThis.services.db
    .select({
      id: chatMessages.id,
      createdAt: chatMessages.createdAt,
      archivedAt: chatMessages.archivedAt,
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
      pinnedAt: chatThreads.pinnedAt,
      renamedAt: chatThreads.renamedAt,
      isRead: sql<boolean>`CASE
        WHEN ${lastMessage.id} IS NULL THEN true
        ELSE COALESCE(${chatThreads.lastReadMessageId} = ${lastMessage.id}, false)
      END`,
      lastMessageArchivedAt: lastMessage.archivedAt,
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
    })
    .from(chatThreads)
    .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
    .leftJoinLateral(lastMessage, sql`true`)
    .where(and(...filters))
    .orderBy(
      sql`(${chatThreads.pinnedAt} IS NULL)`,
      desc(sql`COALESCE(${lastMessage.createdAt}, ${chatThreads.createdAt})`),
    );

  return threads;
}

interface ChatThreadModelPin {
  modelProviderId: string | null;
  modelProviderType: string | null;
  modelProviderCredentialScope: string | null;
  selectedModel: string | null;
}

export async function getFirstRunModelPinForThread(
  threadId: string,
): Promise<ChatThreadModelPin | null> {
  const [run] = await globalThis.services.db
    .select({
      modelProviderId: zeroRuns.modelProviderId,
      modelProviderType: zeroRuns.modelProvider,
      modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
      selectedModel: zeroRuns.selectedModel,
    })
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
  return run;
}

/**
 * Mark a thread read up to its current latest message.
 *
 * Idempotent: when the stored message id already matches the latest message,
 * no row is updated and callers should not emit realtime fanout.
 */
export async function markThreadRead(
  userId: string,
  threadId: string,
): Promise<{ lastReadMessageId: string | null; changed: boolean }> {
  const [thread] = await globalThis.services.db
    .select({ lastReadMessageId: chatThreads.lastReadMessageId })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) {
    throw notFound("Chat thread not found");
  }

  const [latestMessage] = await globalThis.services.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        visibleChatMessageCondition(),
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);

  const latestMessageId = latestMessage?.id ?? null;
  if (thread.lastReadMessageId === latestMessageId) {
    return { lastReadMessageId: latestMessageId, changed: false };
  }

  await globalThis.services.db
    .update(chatThreads)
    .set({ lastReadMessageId: latestMessageId })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));

  return { lastReadMessageId: latestMessageId, changed: true };
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
      modelProviderId: chatThreads.modelProviderId,
      modelProviderType: chatThreads.modelProviderType,
      modelProviderCredentialScope: chatThreads.modelProviderCredentialScope,
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
    modelProviderId: thread.modelProviderId ?? null,
    modelProviderType: thread.modelProviderType ?? null,
    modelProviderCredentialScope: thread.modelProviderCredentialScope ?? null,
    selectedModel: thread.selectedModel ?? null,
    orgId: thread.orgId ?? null,
    lastReadMessageId: thread.lastReadMessageId ?? null,
    renamedAt: thread.renamedAt ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

/**
 * Mirrors the SQL `hasDraft` projection in `listChatThreads`: a thread "has a
 * draft" when its draft text is non-empty OR it has at least one attachment.
 */
function hasDraftValue(
  draftContent: string | null,
  draftAttachments: PersistedAttachment[] | null,
): boolean {
  return (
    (draftContent !== null && draftContent !== "") ||
    (draftAttachments !== null && draftAttachments.length > 0)
  );
}

/**
 * Update a chat thread's draft content and attachments.
 * Ownership check in WHERE clause ensures users can only update their own threads.
 *
 * Publishes `threadListChanged` only when the boolean `hasDraft` flag flips,
 * so that continued typing inside an already-drafting thread does not spam
 * sidebar reloads.
 */
export async function updateChatThreadDraft(
  threadId: string,
  userId: string,
  draftContent: string | null,
  draftAttachments: PersistedAttachment[] | null,
): Promise<void> {
  const [before] = await globalThis.services.db
    .select({
      draftContent: chatThreads.draftContent,
      draftAttachments: chatThreads.draftAttachments,
    })
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));

  if (!before) {
    throw notFound("Chat thread not found");
  }

  await globalThis.services.db
    .update(chatThreads)
    .set({ draftContent, draftAttachments })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));

  const hadDraft = hasDraftValue(before.draftContent, before.draftAttachments);
  const hasDraft = hasDraftValue(draftContent, draftAttachments);
  if (hadDraft !== hasDraft) {
    await publishThreadListChanged(userId);
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
 * Pin a chat thread to the top of the sidebar list. Idempotent: re-pinning
 * an already-pinned thread refreshes `pinned_at` to the current time.
 */
export async function pinChatThread(
  threadId: string,
  userId: string,
): Promise<void> {
  const updated = await globalThis.services.db
    .update(chatThreads)
    .set({ pinnedAt: new Date() })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (updated.length === 0) {
    throw notFound("Chat thread not found");
  }
}

/**
 * Clear the pin from a chat thread. Idempotent: unpinning an already-unpinned
 * thread is a no-op write but still succeeds.
 */
export async function unpinChatThread(
  threadId: string,
  userId: string,
): Promise<void> {
  const updated = await globalThis.services.db
    .update(chatThreads)
    .set({ pinnedAt: null })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (updated.length === 0) {
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

/**
 * Rename a chat thread from the UI. Sets both the title and `renamed_at`,
 * which signals that this thread has been manually renamed and future
 * automated title generation should be suppressed.
 */
export async function renameChatThread(
  threadId: string,
  userId: string,
  title: string,
): Promise<void> {
  const updated = await globalThis.services.db
    .update(chatThreads)
    .set({ title, renamedAt: new Date() })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });

  if (updated.length === 0) {
    throw notFound("Chat thread not found");
  }

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

export async function getChatThreadArtifacts(
  threadId: string,
  userId: string,
): Promise<ChatThreadArtifactRun[]> {
  await getChatThread(threadId, userId);

  const rows = await globalThis.services.db
    .select({
      runId: runUploadedFiles.runId,
      externalId: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      sizeBytes: runUploadedFiles.sizeBytes,
      url: runUploadedFiles.url,
      createdAt: runUploadedFiles.createdAt,
    })
    .from(runUploadedFiles)
    .innerJoin(zeroRuns, eq(zeroRuns.id, runUploadedFiles.runId))
    .innerJoin(agentRuns, eq(agentRuns.id, runUploadedFiles.runId))
    .where(
      and(
        eq(runUploadedFiles.userId, userId),
        or(
          eq(zeroRuns.chatThreadId, threadId),
          sql`EXISTS (
            SELECT 1
            FROM ${chatMessages}
            WHERE ${chatMessages.runId} = ${runUploadedFiles.runId}
              AND ${chatMessages.chatThreadId} = ${threadId}
          )`,
        ),
      ),
    )
    .orderBy(asc(agentRuns.createdAt), asc(runUploadedFiles.createdAt));

  const byRun = new Map<string, ChatThreadArtifactRun>();

  for (const row of rows) {
    if (!row.url) {
      continue;
    }
    const filename = row.filename ?? row.externalId;
    const ext = filename.split(".").pop()?.toLowerCase();
    const existing = byRun.get(row.runId) ?? { runId: row.runId, files: [] };
    existing.files.push({
      id: row.externalId,
      filename,
      contentType:
        row.contentType ??
        (ext ? EXT_MIMETYPE_MAP[ext] : undefined) ??
        "application/octet-stream",
      size: row.sizeBytes ?? 0,
      url: row.url,
      createdAt: row.createdAt.toISOString(),
    });
    byRun.set(row.runId, existing);
  }

  return Array.from(byRun.values()).filter((run) => {
    return run.files.length > 0;
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
