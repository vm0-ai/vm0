import { command } from "ccstate";
import { z } from "zod";
import type {
  SlackMemoryBackfillRequest,
  SlackMemoryStatusResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  relationshipBackfillJobs,
  type RelationshipBackfillJobStatus,
} from "@vm0/db/schema/relationship-memory";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import type { SlackFile } from "../../lib/slack-webhook-context";
import { createSlackClient } from "../external/slack-message-client";
import { nowDate } from "../external/time";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  recordSlackMessageMemorySource,
  type SlackMemoryChannelType,
} from "./slack-memory-source.service";

const log = logger("api:slack-memory-backfill");
const SLACK_BACKFILL_HISTORY_PAGE_SIZE = 100;
const SLACK_BACKFILL_CONVERSATION_PAGE_SIZE = 100;
const BACKFILL_LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_BACKFILL_JOBS_PER_DRAIN = 1;

type SlackMemoryBackfillStatus = RelationshipBackfillJobStatus | "idle";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface SlackBackfillChannel {
  readonly id: string;
  readonly type: SlackMemoryChannelType;
  readonly name: string | null;
}

interface SlackBackfillCursor {
  readonly conversationCursor: string | null;
  readonly pendingChannels: readonly SlackBackfillChannel[];
  readonly currentChannel: SlackBackfillChannel | null;
  readonly historyCursor: string | null;
}

interface SlackMemoryAccess {
  readonly botToken: string;
  readonly workspaceId: string;
  readonly workspaceName: string | null;
  readonly slackUserId: string;
  readonly connectionId: string;
}

type SlackMemoryMutationResult =
  | { readonly kind: "ok"; readonly status: SlackMemoryStatusResponse }
  | { readonly kind: "bad-request"; readonly message: string };

const slackBackfillChannelSchema = z.object({
  id: z.string(),
  type: z.enum(["channel", "group", "mpim", "im", "unknown"]),
  name: z.string().nullable(),
});

const slackBackfillCursorSchema = z.object({
  conversationCursor: z.string().nullable().default(null),
  pendingChannels: z.array(slackBackfillChannelSchema).default([]),
  currentChannel: slackBackfillChannelSchema.nullable().default(null),
  historyCursor: z.string().nullable().default(null),
});

const slackBackfillOptionsSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
  includePublicChannels: z.boolean(),
  includePrivateChannels: z.boolean(),
  includeDirectMessages: z.boolean(),
});

interface SlackConversation {
  readonly id?: string;
  readonly name?: string;
  readonly is_channel?: boolean;
  readonly is_group?: boolean;
  readonly is_im?: boolean;
  readonly is_mpim?: boolean;
  readonly is_member?: boolean;
  readonly is_archived?: boolean;
}

interface SlackHistoryMessage {
  readonly user?: string;
  readonly text?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly files?: readonly SlackFile[];
}

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function parseBackfillCursor(value: string | null): SlackBackfillCursor {
  if (!value) {
    return {
      conversationCursor: null,
      pendingChannels: [],
      currentChannel: null,
      historyCursor: null,
    };
  }
  return slackBackfillCursorSchema.parse(JSON.parse(value) as unknown);
}

function serializeBackfillCursor(value: SlackBackfillCursor): string | null {
  if (
    !value.conversationCursor &&
    value.pendingChannels.length === 0 &&
    !value.currentChannel &&
    !value.historyCursor
  ) {
    return null;
  }
  return JSON.stringify(value);
}

function parseBackfillOptions(value: string): SlackMemoryBackfillRequest {
  return slackBackfillOptionsSchema.parse(JSON.parse(value) as unknown);
}

function slackConversationTypes(options: SlackMemoryBackfillRequest): string {
  const types: string[] = [];
  if (options.includePublicChannels) {
    types.push("public_channel");
  }
  if (options.includePrivateChannels) {
    types.push("private_channel");
  }
  if (options.includeDirectMessages) {
    types.push("im", "mpim");
  }
  return types.join(",");
}

function channelTypeFromConversation(
  conversation: SlackConversation,
): SlackMemoryChannelType | null {
  if (!conversation.id || conversation.is_archived) {
    return null;
  }
  if (conversation.is_channel) {
    return conversation.is_member === false ? null : "channel";
  }
  if (conversation.is_group) {
    return conversation.is_member === false ? null : "group";
  }
  if (conversation.is_mpim) {
    return "mpim";
  }
  if (conversation.is_im) {
    return "im";
  }
  return null;
}

function isBackfillableSlackMessage(
  message: SlackHistoryMessage,
  slackUserId: string,
): message is SlackHistoryMessage & {
  readonly user: string;
  readonly ts: string;
} {
  return (
    message.user === slackUserId &&
    typeof message.ts === "string" &&
    (!message.subtype || message.subtype === "file_share") &&
    !message.bot_id
  );
}

export async function resolveSlackMemoryAccess(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<
  | { readonly kind: "ok"; readonly access: SlackMemoryAccess }
  | { readonly kind: "bad-request"; readonly message: string }
> {
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, scope.orgId))
    .limit(1);

  if (!installation?.orgId) {
    return {
      kind: "bad-request",
      message: "Install Slack for this organization before backfilling.",
    };
  }

  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, scope.userId),
        eq(slackOrgConnections.slackWorkspaceId, installation.slackWorkspaceId),
      ),
    )
    .limit(1);

  if (!connection) {
    return {
      kind: "bad-request",
      message: "Connect your Slack account before backfilling.",
    };
  }

  const context = await loadUserFeatureSwitchContext(
    db,
    scope.orgId,
    scope.userId,
  );
  const botToken = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    context,
  );

  return {
    kind: "ok",
    access: {
      botToken,
      workspaceId: installation.slackWorkspaceId,
      workspaceName: installation.slackWorkspaceName ?? null,
      slackUserId: connection.slackUserId,
      connectionId: connection.id,
    },
  };
}

export async function getSlackMemoryStatus(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<SlackMemoryStatusResponse> {
  const [installation] = await db
    .select({
      workspaceId: slackOrgInstallations.slackWorkspaceId,
      workspaceName: slackOrgInstallations.slackWorkspaceName,
    })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, scope.orgId))
    .limit(1);

  const connectionRows = installation
    ? await db
        .select({ id: slackOrgConnections.id })
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.vm0UserId, scope.userId),
            eq(slackOrgConnections.slackWorkspaceId, installation.workspaceId),
          ),
        )
        .limit(1)
    : [];
  const connection = connectionRows[0];

  const [backfill] = await db
    .select({
      status: relationshipBackfillJobs.status,
      estimatedTotal: relationshipBackfillJobs.estimatedTotal,
      scannedCount: relationshipBackfillJobs.scannedCount,
      recordedCount: relationshipBackfillJobs.enqueuedCount,
      lastError: relationshipBackfillJobs.lastError,
      updatedAt: relationshipBackfillJobs.updatedAt,
      completedAt: relationshipBackfillJobs.completedAt,
    })
    .from(relationshipBackfillJobs)
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "slack"),
      ),
    )
    .limit(1);

  return {
    provider: "slack",
    workspaceConnected: Boolean(installation),
    userConnected: Boolean(connection),
    workspaceName: installation?.workspaceName ?? null,
    backfill: {
      status: (backfill?.status ?? "idle") as SlackMemoryBackfillStatus,
      estimatedTotal: backfill?.estimatedTotal ?? null,
      scannedCount: backfill?.scannedCount ?? 0,
      recordedCount: backfill?.recordedCount ?? 0,
      lastError: backfill?.lastError ?? null,
      updatedAt: serializeDate(backfill?.updatedAt ?? null),
      completedAt: serializeDate(backfill?.completedAt ?? null),
    },
  };
}

async function upsertSlackBackfillJob(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly connectionId: string;
  readonly options: SlackMemoryBackfillRequest;
}): Promise<void> {
  const currentTime = nowDate();
  await args.db
    .insert(relationshipBackfillJobs)
    .values({
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      provider: "slack",
      connectorId: args.connectionId,
      status: "pending",
      query: JSON.stringify(args.options),
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipBackfillJobs.orgId,
        relationshipBackfillJobs.userId,
        relationshipBackfillJobs.provider,
      ],
      set: {
        connectorId: args.connectionId,
        status: "pending",
        query: JSON.stringify(args.options),
        nextPageToken: null,
        estimatedTotal: null,
        scannedCount: 0,
        enqueuedCount: 0,
        lockedAt: null,
        lastRunAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: currentTime,
      },
    });
}

export async function restartSlackMemoryBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly options: SlackMemoryBackfillRequest;
  readonly signal: AbortSignal;
}): Promise<SlackMemoryMutationResult> {
  if (
    !args.options.includePublicChannels &&
    !args.options.includePrivateChannels &&
    !args.options.includeDirectMessages
  ) {
    return {
      kind: "bad-request",
      message: "Select at least one Slack conversation type.",
    };
  }

  const scope = { orgId: args.orgId, userId: args.userId };
  const access = await resolveSlackMemoryAccess(args.db, scope);
  args.signal.throwIfAborted();
  if (access.kind !== "ok") {
    return { kind: "bad-request", message: access.message };
  }

  await upsertSlackBackfillJob({
    db: args.db,
    scope,
    connectionId: access.access.connectionId,
    options: args.options,
  });
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getSlackMemoryStatus(args.db, scope),
  };
}

export async function stopSlackMemoryBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<SlackMemoryMutationResult> {
  const scope = { orgId: args.orgId, userId: args.userId };
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: "stopped",
      lockedAt: null,
      lastError: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "slack"),
        inArray(relationshipBackfillJobs.status, ["pending", "running"]),
      ),
    );
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getSlackMemoryStatus(args.db, scope),
  };
}

async function listSlackBackfillConversations(args: {
  readonly botToken: string;
  readonly cursor: string | null;
  readonly options: SlackMemoryBackfillRequest;
}) {
  const client = createSlackClient(args.botToken);
  const result = await client.conversations.list({
    types: slackConversationTypes(args.options),
    exclude_archived: true,
    limit: SLACK_BACKFILL_CONVERSATION_PAGE_SIZE,
    cursor: args.cursor ?? undefined,
  });

  if (!result.ok) {
    throw new Error("Failed to list Slack conversations for memory backfill");
  }

  const channels = ((result.channels ?? []) as SlackConversation[]).flatMap(
    (conversation): SlackBackfillChannel[] => {
      const type = channelTypeFromConversation(conversation);
      if (!type || !conversation.id) {
        return [];
      }
      return [
        {
          id: conversation.id,
          type,
          name: conversation.name ?? null,
        },
      ];
    },
  );

  return {
    channels,
    nextCursor: result.response_metadata?.next_cursor || null,
  };
}

async function ensureCurrentChannel(args: {
  readonly botToken: string;
  readonly cursor: SlackBackfillCursor;
  readonly options: SlackMemoryBackfillRequest;
}): Promise<SlackBackfillCursor> {
  let cursor = args.cursor;

  while (!cursor.currentChannel && cursor.pendingChannels.length === 0) {
    const listed = await listSlackBackfillConversations({
      botToken: args.botToken,
      cursor: cursor.conversationCursor,
      options: args.options,
    });

    if (listed.channels.length > 0) {
      cursor = {
        ...cursor,
        conversationCursor: listed.nextCursor,
        pendingChannels: listed.channels,
      };
      break;
    }

    if (!listed.nextCursor) {
      return {
        conversationCursor: null,
        pendingChannels: [],
        currentChannel: null,
        historyCursor: null,
      };
    }

    cursor = {
      ...cursor,
      conversationCursor: listed.nextCursor,
    };
  }

  if (!cursor.currentChannel && cursor.pendingChannels.length > 0) {
    const [currentChannel, ...pendingChannels] = cursor.pendingChannels;
    return {
      ...cursor,
      currentChannel: currentChannel ?? null,
      pendingChannels,
      historyCursor: null,
    };
  }

  return cursor;
}

async function listSlackHistoryPage(args: {
  readonly botToken: string;
  readonly channelId: string;
  readonly historyCursor: string | null;
  readonly oldestSeconds: number;
}) {
  const client = createSlackClient(args.botToken);
  const result = await client.conversations.history({
    channel: args.channelId,
    cursor: args.historyCursor ?? undefined,
    limit: SLACK_BACKFILL_HISTORY_PAGE_SIZE,
    oldest: String(args.oldestSeconds),
  });

  if (!result.ok) {
    throw new Error(
      "Failed to list Slack conversation history for memory backfill",
    );
  }

  return {
    messages: (result.messages ?? []) as SlackHistoryMessage[],
    nextCursor: result.response_metadata?.next_cursor || null,
  };
}

async function processSlackBackfillJob(
  db: Db,
  job: typeof relationshipBackfillJobs.$inferSelect,
  signal: AbortSignal,
): Promise<{ readonly scanned: number; readonly recorded: number }> {
  const scope = { orgId: job.orgId, userId: job.userId };
  const access = await resolveSlackMemoryAccess(db, scope);
  signal.throwIfAborted();
  if (access.kind !== "ok") {
    throw new Error(access.message);
  }

  const options = parseBackfillOptions(job.query);
  const cursor = await ensureCurrentChannel({
    botToken: access.access.botToken,
    cursor: parseBackfillCursor(job.nextPageToken),
    options,
  });
  signal.throwIfAborted();

  if (!cursor.currentChannel) {
    const currentTime = nowDate();
    await db
      .update(relationshipBackfillJobs)
      .set({
        status: "done",
        nextPageToken: null,
        lockedAt: null,
        lastRunAt: currentTime,
        completedAt: currentTime,
        lastError: null,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(relationshipBackfillJobs.id, job.id),
          eq(relationshipBackfillJobs.status, "running"),
        ),
      );
    return { scanned: 0, recorded: 0 };
  }

  const oldestSeconds = Math.floor(
    (nowDate().getTime() - options.days * 24 * 60 * 60 * 1000) / 1000,
  );
  const listed = await listSlackHistoryPage({
    botToken: access.access.botToken,
    channelId: cursor.currentChannel.id,
    historyCursor: cursor.historyCursor,
    oldestSeconds,
  });
  signal.throwIfAborted();

  let recorded = 0;
  for (const message of listed.messages) {
    signal.throwIfAborted();
    if (!isBackfillableSlackMessage(message, access.access.slackUserId)) {
      continue;
    }

    const didRecord = await recordSlackMessageMemorySource({
      db,
      orgId: job.orgId,
      userId: job.userId,
      workspaceId: access.access.workspaceId,
      channelId: cursor.currentChannel.id,
      channelType: cursor.currentChannel.type,
      slackUserId: message.user,
      messageText: message.text ?? "",
      messageTs: message.ts,
      threadTs: message.thread_ts,
      files: message.files,
    });
    signal.throwIfAborted();
    if (didRecord) {
      recorded += 1;
    }
  }

  const nextCursor: SlackBackfillCursor = listed.nextCursor
    ? {
        ...cursor,
        historyCursor: listed.nextCursor,
      }
    : {
        ...cursor,
        currentChannel: null,
        historyCursor: null,
      };
  const serializedCursor = serializeBackfillCursor(nextCursor);
  const completed = serializedCursor === null;
  const currentTime = nowDate();

  await db
    .update(relationshipBackfillJobs)
    .set({
      status: completed ? "done" : "pending",
      nextPageToken: serializedCursor,
      estimatedTotal: null,
      scannedCount: sql`${relationshipBackfillJobs.scannedCount} + ${listed.messages.length}`,
      enqueuedCount: sql`${relationshipBackfillJobs.enqueuedCount} + ${recorded}`,
      lockedAt: null,
      lastRunAt: currentTime,
      completedAt: completed ? currentTime : null,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );

  return { scanned: listed.messages.length, recorded };
}

async function markSlackBackfillFailed(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly error: unknown;
}) {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  const retry = args.job.attempts + 1 < 3;
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: retry ? "pending" : "failed",
      lockedAt: null,
      attempts: sql`${relationshipBackfillJobs.attempts} + 1`,
      lastError: message,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, args.job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );
}

export const advanceSlackMemorySourceBackfillJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const staleBefore = new Date(
      currentTime.getTime() - BACKFILL_LOCK_STALE_MS,
    );
    const jobs = await db
      .select()
      .from(relationshipBackfillJobs)
      .where(
        and(
          eq(relationshipBackfillJobs.provider, "slack"),
          inArray(relationshipBackfillJobs.status, ["pending", "running"]),
          or(
            isNull(relationshipBackfillJobs.lockedAt),
            lt(relationshipBackfillJobs.lockedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(relationshipBackfillJobs.updatedAt))
      .limit(MAX_BACKFILL_JOBS_PER_DRAIN);
    signal.throwIfAborted();

    let processed = 0;
    let failed = 0;
    let scanned = 0;
    let enqueued = 0;

    for (const job of jobs) {
      const [lockedJob] = await db
        .update(relationshipBackfillJobs)
        .set({
          status: "running",
          lockedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(relationshipBackfillJobs.id, job.id),
            inArray(relationshipBackfillJobs.status, ["pending", "running"]),
            or(
              isNull(relationshipBackfillJobs.lockedAt),
              lt(relationshipBackfillJobs.lockedAt, staleBefore),
            ),
          ),
        )
        .returning();
      signal.throwIfAborted();
      if (!lockedJob) {
        continue;
      }

      const result = await settle(
        processSlackBackfillJob(db, lockedJob, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok) {
        processed += 1;
        scanned += result.value.scanned;
        enqueued += result.value.recorded;
        continue;
      }

      failed += 1;
      log.warn("Slack memory source backfill failed", {
        jobId: lockedJob.id,
        error:
          result.error instanceof Error
            ? result.error.message
            : String(result.error),
      });
      await markSlackBackfillFailed({
        db,
        job: lockedJob,
        error: result.error,
      });
      signal.throwIfAborted();
    }

    return { processed, failed, scanned, enqueued };
  },
);
