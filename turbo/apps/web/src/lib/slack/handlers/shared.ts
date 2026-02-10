import { eq, and, isNull } from "drizzle-orm";
import {
  createSlackClient,
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  formatContextForAgentWithImages,
  getSlackRedirectBaseUrl,
} from "../index";
import { slackThreadSessions } from "../../../db/schema/slack-thread-session";
import { storages, storageVersions } from "../../../db/schema/storage";
import { getPlatformUrl } from "../../url";
import {
  getUserScopeByClerkId,
  createUserScope,
  generateDefaultScopeSlug,
} from "../../scope/scope-service";
import { computeContentHashFromHashes } from "../../storage/content-hash";
import { putS3Object } from "../../s3/s3-client";
import { env } from "../../../env";
import { logger } from "../../logger";

const log = logger("slack:shared");

export type SlackClient = ReturnType<typeof createSlackClient>;

/**
 * Remove the thinking reaction from a message
 */
export async function removeThinkingReaction(
  client: SlackClient,
  channelId: string,
  messageTs: string,
): Promise<void> {
  await client.reactions
    .remove({
      channel: channelId,
      timestamp: messageTs,
      name: "thought_balloon",
    })
    .catch(() => {
      // Ignore errors when removing reaction
    });
}

/**
 * Fetch conversation context with deduplication support.
 * Returns separate contexts for routing (text-only, full history) and
 * execution (with images, only new messages since lastProcessedMessageTs).
 *
 * Single Slack API call — messages are fetched once and filtered in-memory.
 */
export async function fetchConversationContexts(
  client: SlackClient,
  channelId: string,
  threadTs: string | undefined,
  botUserId: string,
  botToken: string,
  lastProcessedMessageTs?: string,
  currentMessageTs?: string,
): Promise<{ routingContext: string; executionContext: string }> {
  const imageSessionId = `${channelId}-${threadTs ?? "channel"}`;
  const contextType = threadTs ? "thread" : "channel";

  // Fetch all messages once (single Slack API call)
  const allMessages = threadTs
    ? await fetchThreadContext(client, channelId, threadTs)
    : await fetchChannelContext(client, channelId, 10);

  // Exclude the current message (it's already sent as the prompt)
  const contextMessages = currentMessageTs
    ? allMessages.filter((m) => m.ts !== currentMessageTs)
    : allMessages;

  // Text-only full context for routing (no image uploads needed)
  const routingContext = formatContextForAgent(
    contextMessages,
    botUserId,
    contextType,
  );

  // Filter to only new messages for execution context
  const executionMessages = lastProcessedMessageTs
    ? contextMessages.filter((m) => !m.ts || m.ts > lastProcessedMessageTs)
    : contextMessages;

  // Format execution context with images (only uploads images for new messages)
  const executionContext =
    executionMessages.length > 0
      ? await formatContextForAgentWithImages(
          executionMessages,
          botToken,
          imageSessionId,
          botUserId,
          contextType,
        )
      : "";

  return { routingContext, executionContext };
}

interface ThreadSessionLookup {
  existingSessionId: string | undefined;
  lastProcessedMessageTs: string | undefined;
}

/**
 * Look up an existing thread session by channel + thread.
 * Optionally refines with bindingId if provided.
 */
export async function lookupThreadSession(
  channelId: string,
  threadTs: string,
  bindingId?: string,
): Promise<ThreadSessionLookup> {
  const conditions = bindingId
    ? [
        eq(slackThreadSessions.slackBindingId, bindingId),
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ]
    : [
        eq(slackThreadSessions.slackChannelId, channelId),
        eq(slackThreadSessions.slackThreadTs, threadTs),
      ];

  const [session] = await globalThis.services.db
    .select({
      agentSessionId: slackThreadSessions.agentSessionId,
      lastProcessedMessageTs: slackThreadSessions.lastProcessedMessageTs,
    })
    .from(slackThreadSessions)
    .where(and(...conditions))
    .limit(1);

  return {
    existingSessionId: session?.agentSessionId,
    lastProcessedMessageTs: session?.lastProcessedMessageTs ?? undefined,
  };
}

/**
 * Create or update a thread session mapping after agent execution.
 */
export async function saveThreadSession(opts: {
  bindingId: string;
  channelId: string;
  threadTs: string;
  existingSessionId: string | undefined;
  newSessionId: string | undefined;
  messageTs: string;
  runStatus: string;
}): Promise<void> {
  const {
    bindingId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    messageTs,
    runStatus,
  } = opts;

  if (!existingSessionId && newSessionId) {
    // New thread — create mapping
    await globalThis.services.db
      .insert(slackThreadSessions)
      .values({
        slackBindingId: bindingId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
        agentSessionId: newSessionId,
        lastProcessedMessageTs: messageTs,
      })
      .onConflictDoNothing();
  } else if (
    existingSessionId &&
    (runStatus === "completed" || runStatus === "timeout")
  ) {
    // Existing thread, successful run — update lastProcessedMessageTs
    await globalThis.services.db
      .update(slackThreadSessions)
      .set({
        lastProcessedMessageTs: messageTs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slackThreadSessions.slackBindingId, bindingId),
          eq(slackThreadSessions.slackChannelId, channelId),
          eq(slackThreadSessions.slackThreadTs, threadTs),
        ),
      );
  }
  // Failed runs — do not update lastProcessedMessageTs (allows retry with same context)
}

/**
 * Build the login URL
 */
export function buildLoginUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
): string {
  const baseUrl = getSlackRedirectBaseUrl();
  const params = new URLSearchParams({
    w: workspaceId,
    u: slackUserId,
    c: channelId,
  });
  return `${baseUrl}/slack/link?${params.toString()}`;
}

/**
 * Build the logs URL for a run
 */
export function buildLogsUrl(runId: string): string {
  return `${getPlatformUrl()}/logs/${runId}`;
}

/**
 * Ensure scope and artifact storage exist for a user.
 * Safety net for all agent link paths (App Home button, slash command, submission).
 *
 * Follows the same prepare/commit pattern as `vm0 cook`:
 * 1. Find-or-create storage record
 * 2. If no HEAD version, create an empty initial version (upload manifest to S3 + commit)
 */
export async function ensureScopeAndArtifact(vm0UserId: string): Promise<void> {
  let scope = await getUserScopeByClerkId(vm0UserId);
  if (!scope) {
    scope = await createUserScope(
      vm0UserId,
      generateDefaultScopeSlug(vm0UserId),
    );
    log.info("Auto-created scope for Slack user", { userId: vm0UserId });
  }

  // Find or create storage record
  let [storage] = await globalThis.services.db
    .select()
    .from(storages)
    .where(
      and(
        eq(storages.scopeId, scope.id),
        eq(storages.name, "artifact"),
        eq(storages.type, "artifact"),
      ),
    )
    .limit(1);

  if (!storage) {
    const [newStorage] = await globalThis.services.db
      .insert(storages)
      .values({
        scopeId: scope.id,
        name: "artifact",
        type: "artifact",
        userId: vm0UserId,
        s3Prefix: `${scope.slug}/artifact/artifact`,
        size: 0,
        fileCount: 0,
      })
      .onConflictDoNothing()
      .returning();

    if (!newStorage) {
      // Race condition: another request created it. Re-fetch.
      const [existing] = await globalThis.services.db
        .select()
        .from(storages)
        .where(
          and(
            eq(storages.scopeId, scope.id),
            eq(storages.name, "artifact"),
            eq(storages.type, "artifact"),
          ),
        )
        .limit(1);
      storage = existing;
    } else {
      storage = newStorage;
    }
    log.info("Auto-created artifact storage", { userId: vm0UserId });
  }

  if (!storage) return;

  // If HEAD version already exists, nothing more to do
  if (storage.headVersionId) return;

  // Create initial empty version synchronously — this only runs during the
  // link flow (server action) so there is no Slack timeout constraint.
  const storageId = storage.id;
  const scopeSlug = scope.slug;
  try {
    const versionId = computeContentHashFromHashes(storageId, []);
    const s3Key = `${scopeSlug}/artifact/artifact/${versionId}`;
    const manifestKey = `${s3Key}/manifest.json`;
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;

    await putS3Object(
      bucketName,
      manifestKey,
      JSON.stringify({ files: [] }),
      "application/json",
    );

    await globalThis.services.db.transaction(async (tx) => {
      await tx
        .insert(storageVersions)
        .values({
          id: versionId,
          storageId,
          s3Key,
          size: 0,
          fileCount: 0,
          message: "Initial empty artifact (auto-created via Slack)",
          createdBy: "user",
        })
        .onConflictDoNothing();

      await tx
        .update(storages)
        .set({
          headVersionId: versionId,
          size: 0,
          fileCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(storages.id, storageId));
    });

    log.info("Auto-created initial artifact version", {
      userId: vm0UserId,
      versionId,
    });
  } catch (err) {
    log.error("Failed to create initial artifact version", { err });
    // Clean up the headless storage so the next call can retry
    await globalThis.services.db
      .delete(storages)
      .where(and(eq(storages.id, storageId), isNull(storages.headVersionId)))
      .catch((cleanupErr) => {
        log.error("Failed to clean up headless storage", { cleanupErr });
      });
  }
}
