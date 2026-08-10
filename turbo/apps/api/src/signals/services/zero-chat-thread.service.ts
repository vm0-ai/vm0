import { command, computed, type Computed } from "ccstate";
import {
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import {
  chatEventResponse,
  type ChatSearchMessage,
  type ChatSearchResult,
  type ChatThreadDraft,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type CodexServiceTier,
  type ChatEvent,
  type PersistedAttachment,
  type UserMessageDocument,
  type UserMessageInputDocument,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  modelProviderCredentialScopeSchema,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  type HostedArtifactKind,
  hostedArtifactKindSchema,
} from "@vm0/api-contracts/contracts/zero-host";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatEvents,
  type ChatEventUsagePayload,
  type ChatEventUserMessage,
} from "@vm0/db/schema/chat-event";
import { chatEventSearchDocs } from "@vm0/db/schema/chat-event-search";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { alias } from "drizzle-orm/pg-core";
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
  lt,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import {
  chatSearchBigramTsquery,
  chatSearchMatchRanges,
} from "../../lib/chat-search-bigram";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import {
  inferMimetype,
  visibleChatEventCondition,
} from "./zero-chat-event-shared.service";
import { latestRunFinishEventSubquery } from "./zero-chat-thread-read-state-query";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";
import { excludeGoalMarkerCondition } from "./zero-chat-goal-marker.service";
import { cancelRun$, type CancelRunResult } from "./zero-run-cancel.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";
import {
  chatEventTextCondition,
  legacyRunOwnedChatEventCondition,
} from "./zero-chat-event-type.service";
import { cancellationRecoveryPendingForThread } from "./zero-chat-active-run.service";

const matchedChatEvent = alias(chatEvents, "matched_chat_event");

type ChatEventRow = {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: ChatEventType;
  readonly content: string | null;
  readonly userMessage: ChatEventUserMessage | null;
  readonly thinking: string | null;
  readonly runId: string | null;
  readonly runGroupId: string | null;
  readonly usagePayload: ChatEventUsagePayload | null;
  readonly runEventId: string | null;
  readonly error: string | null;
  readonly seqId: number;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly revokesEventId: string | null;
  readonly interruptsRunId: string | null;
};

type ChatSearchMessageRow = {
  readonly messageId: string;
  readonly chatThreadId: string;
  readonly eventType: ChatEventType;
  readonly content: string | null;
  readonly userMessage: UserMessageDocument | null;
  readonly createdAt: Date;
  readonly seqId: number;
  readonly sequenceNumber: number | null;
  readonly runId: string | null;
};

type ChatSearchMatchRow = ChatSearchMessageRow & {
  readonly agentName: string;
};

interface ChatSearchContext {
  readonly before: ChatSearchMessage[];
  readonly after: ChatSearchMessage[];
}

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

function effectiveChatEventRunId() {
  return sql`CASE
    WHEN ${chatEvents.eventType} = 'control.interrupt' THEN NULL
    ELSE ${chatEvents.runId}
  END`.mapWith(nullableDriverValueDecoder(chatEvents.runId));
}

const eventColumns = {
  id: chatEvents.id,
  chatThreadId: chatEvents.chatThreadId,
  eventType: chatEvents.eventType,
  content: chatEvents.content,
  userMessage: chatEvents.userMessage,
  thinking: chatEvents.thinking,
  runId: effectiveChatEventRunId(),
  runGroupId: chatEvents.runGroupId,
  usagePayload: chatEvents.usagePayload,
  runEventId: chatEvents.runEventId,
  error: chatEvents.error,
  seqId: chatEvents.seqId,
  sequenceNumber: chatEvents.runEventSequenceNumber,
  createdAt: chatEvents.createdAt,
  revokesEventId: chatEvents.revokesEventId,
  interruptsRunId: chatEvents.interruptsRunId,
} as const;

function selectChatEvents(db: Pick<Db, "select">) {
  return db.select(eventColumns).from(chatEvents);
}

const searchMessageColumns = {
  messageId: chatEvents.id,
  chatThreadId: chatEvents.chatThreadId,
  eventType: chatEvents.eventType,
  content: chatEvents.content,
  userMessage: chatEvents.userMessage,
  createdAt: chatEvents.createdAt,
  seqId: chatEvents.seqId,
  sequenceNumber: chatEvents.runEventSequenceNumber,
  runId: effectiveChatEventRunId(),
} as const;

const searchContextMessageColumns = {
  ...searchMessageColumns,
  eventType: sql`${chatEvents.eventType}`
    .mapWith(chatEvents.eventType)
    .as("context_event_type"),
} as const;

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

function normalizeUsagePayload(
  value: ChatEventUsagePayload | null,
): Extract<ChatEvent, { eventType: "usage.recorded" }>["usage"] | undefined {
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

function requiredChatEventField<T>(
  value: T | null,
  eventType: ChatEventType,
  field: string,
): T {
  if (value === null) {
    throw new Error(`${eventType} chat event is missing ${field}`);
  }
  return value;
}

function baseChatEventFromRow(row: ChatEventRow, content: string | null) {
  return {
    id: row.id,
    threadId: row.chatThreadId,
    content,
    runId: row.runId ?? undefined,
    runGroupId: row.runGroupId ?? undefined,
    runEventId: row.runEventId ?? undefined,
    revokesEventId: row.revokesEventId ?? undefined,
    seqId: row.seqId,
    sequenceNumber: row.sequenceNumber,
    createdAt: row.createdAt.toISOString(),
  };
}

type ChatEventBase = ReturnType<typeof baseChatEventFromRow>;
type ChatEventBuilder = (row: ChatEventRow, event: ChatEventBase) => ChatEvent;

const chatEventBuilders = {
  "input.prompt": (row, event) => {
    return {
      ...event,
      eventType: "input.prompt",
      content: null,
      userMessage: requiredChatEventField(
        row.userMessage,
        row.eventType,
        "userMessage",
      ),
    };
  },
  "input.automation": (row, event) => {
    return {
      ...event,
      eventType: "input.automation",
      content: null,
      userMessage: row.userMessage ?? undefined,
    };
  },
  "input.goal": (row, event) => {
    return {
      id: event.id,
      threadId: event.threadId,
      eventType: "input.goal",
      content: null,
      userMessage: requiredChatEventField(
        row.userMessage,
        row.eventType,
        "userMessage",
      ),
      seqId: event.seqId,
      createdAt: event.createdAt,
    };
  },
  "input.budget": (row, event) => {
    return {
      ...event,
      eventType: "input.budget",
      content: null,
      userMessage: requiredChatEventField(
        row.userMessage,
        row.eventType,
        "userMessage",
      ),
    };
  },
  "input.rejected": (row, event) => {
    return {
      ...event,
      eventType: "input.rejected",
      content: null,
      userMessage: requiredChatEventField(
        row.userMessage,
        row.eventType,
        "userMessage",
      ),
      error: requiredChatEventField(row.error, row.eventType, "error"),
    };
  },
  "output.message": (row, event) => {
    return {
      ...event,
      eventType: "output.message",
      content: requiredChatEventField(row.content, row.eventType, "content"),
    };
  },
  "output.error": (row, event) => {
    return {
      ...event,
      eventType: "output.error",
      error: requiredChatEventField(row.error, row.eventType, "error"),
    };
  },
  "output.thinking": (row, event) => {
    return {
      ...event,
      eventType: "output.thinking",
      content: null,
      thinking: requiredChatEventField(row.thinking, row.eventType, "thinking"),
    };
  },
  "output.followups": (row, event) => {
    return {
      ...event,
      eventType: "output.followups",
      content: requiredChatEventField(row.content, row.eventType, "content"),
    };
  },
  "run.queued": (row, event) => {
    return {
      ...event,
      eventType: "run.queued",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      content: requiredChatEventField(row.content, row.eventType, "content"),
    };
  },
  "run.dequeued": (row, event) => {
    return {
      ...event,
      eventType: "run.dequeued",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      content: null,
      revokesEventId: requiredChatEventField(
        row.revokesEventId,
        row.eventType,
        "revokesEventId",
      ),
    };
  },
  "run.completed": (row, event) => {
    return {
      ...event,
      eventType: "run.completed",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      runLifecycleEvent: "completed",
    };
  },
  "run.failed": (row, event) => {
    return {
      ...event,
      eventType: "run.failed",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      error: row.error ?? undefined,
      runLifecycleEvent: "failed",
    };
  },
  "run.cancelled": (row, event) => {
    return {
      ...event,
      eventType: "run.cancelled",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      error: row.error ?? undefined,
      runLifecycleEvent: "cancelled",
    };
  },
  "control.interrupt": (row, event) => {
    return {
      ...event,
      eventType: "control.interrupt",
      content: null,
      interruptsRunId: requiredChatEventField(
        row.interruptsRunId,
        row.eventType,
        "interruptsRunId",
      ),
    };
  },
  "control.revoke": (row, event) => {
    return {
      ...event,
      eventType: "control.revoke",
      content: null,
      revokesEventId: requiredChatEventField(
        row.revokesEventId,
        row.eventType,
        "revokesEventId",
      ),
    };
  },
  "browser.open": (_row, event) => {
    return {
      ...event,
      eventType: "browser.open",
      content: null,
    };
  },
  "browser.close": (_row, event) => {
    return {
      ...event,
      eventType: "browser.close",
      content: null,
    };
  },
  "goal.open": (row, event) => {
    return {
      id: event.id,
      threadId: event.threadId,
      eventType: "goal.open",
      content: requiredChatEventField(row.content, row.eventType, "content"),
      seqId: event.seqId,
      createdAt: event.createdAt,
    };
  },
  "goal.close": (_row, event) => {
    return {
      id: event.id,
      threadId: event.threadId,
      eventType: "goal.close",
      content: null,
      seqId: event.seqId,
      createdAt: event.createdAt,
    };
  },
  "usage.recorded": (row, event) => {
    return {
      ...event,
      eventType: "usage.recorded",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      content: null,
      usage: requiredChatEventField(
        normalizeUsagePayload(row.usagePayload) ?? null,
        row.eventType,
        "usage",
      ),
    };
  },
} satisfies Record<ChatEvent["eventType"], ChatEventBuilder>;

function toChatEvent(row: ChatEventRow): ChatEvent {
  const event = chatEventBuilders[row.eventType](
    row,
    baseChatEventFromRow(row, row.content),
  );
  return chatEventResponse(event);
}

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;

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
                and(
                  eq(chatEvents.runId, runUploadedFiles.runId),
                  eq(chatEvents.chatThreadId, args.threadId),
                  legacyRunOwnedChatEventCondition(),
                ),
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

function toChatSearchMessage(row: ChatSearchMessageRow): ChatSearchMessage {
  const userMessage = requiredUserMessageForEvent(
    row.eventType,
    row.userMessage,
  );
  const content = userMessage
    ? projectUserMessage(userMessage).displayText
    : row.content;
  if (content === null) {
    throw new Error(
      "chat search invariant violated: searchable message text is null",
    );
  }

  return {
    messageId: row.messageId,
    chatThreadId: row.chatThreadId,
    role: chatEventCompatibilityRole(row.eventType),
    content,
    createdAt: row.createdAt.toISOString(),
    seqId: row.seqId,
    sequenceNumber: row.sequenceNumber,
    runId: row.runId,
  };
}

/**
 * Resolves matches from the chat_event_search_docs projection alone: keyword,
 * ownership, agent scope, `since`, ordering and the limit are all answered by
 * the projection, so no chat_events predicate can pull the planner away from
 * the tsvector index. Keywords without a bigram-indexable form cannot match.
 */
async function chatSearchIndexedEventIds(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
    readonly limit: number;
  },
): Promise<readonly string[]> {
  const tsquery = chatSearchBigramTsquery(args.keyword);
  if (tsquery === null) {
    return [];
  }
  const docs = await db
    .select({ eventId: chatEventSearchDocs.eventId })
    .from(chatEventSearchDocs)
    .where(
      and(
        eq(chatEventSearchDocs.userId, args.userId),
        eq(chatEventSearchDocs.orgId, args.orgId),
        sql`${chatEventSearchDocs.tsv} @@ to_tsquery('simple', ${tsquery})`,
        args.agentId
          ? eq(chatEventSearchDocs.agentComposeId, args.agentId)
          : undefined,
        args.since ? gte(chatEventSearchDocs.createdAt, args.since) : undefined,
      ),
    )
    .orderBy(desc(chatEventSearchDocs.createdAt))
    .limit(args.limit);
  return docs.map((doc) => {
    return doc.eventId;
  });
}

/**
 * Decorates already-selected matches with the columns the response needs. The
 * joins run over at most `limit + 1` primary-key lookups, so they never take
 * part in selecting rows. Ownership is re-asserted against the authoritative
 * thread and compose rows, because the projection only holds a copy of it.
 */
async function chatSearchIndexedMatches(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly eventIds: readonly string[];
  },
): Promise<ChatSearchMatchRow[]> {
  if (args.eventIds.length === 0) {
    return [];
  }
  return await db
    .select({
      ...searchMessageColumns,
      agentName: agentComposes.name,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatEvents.chatThreadId, chatThreads.id))
    .innerJoin(agentComposes, eq(chatThreads.agentComposeId, agentComposes.id))
    .where(
      and(
        inArray(chatEvents.id, [...args.eventIds]),
        eq(chatThreads.userId, args.userId),
        eq(agentComposes.orgId, args.orgId),
      ),
    )
    .orderBy(desc(chatEvents.createdAt));
}

function chatSearchMatchesTable(messageIds: readonly string[]): SQL {
  return sql`unnest(${sql.param([...messageIds])}::uuid[])
    WITH ORDINALITY AS chat_search_matches(message_id, result_ordinality)`;
}

function chatSearchContextSideQuery(
  db: ReadonlyDb,
  args: {
    readonly isBefore: boolean;
    readonly limit: number;
  },
) {
  return db
    .select({
      isBefore: sql`${args.isBefore}::boolean`
        .mapWith(pgBooleanDecoder)
        .as("is_before"),
      ...searchContextMessageColumns,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, matchedChatEvent.chatThreadId),
        args.isBefore
          ? lt(chatEvents.seqId, matchedChatEvent.seqId)
          : gt(chatEvents.seqId, matchedChatEvent.seqId),
        chatEventTextCondition(),
        visibleChatEventCondition(db),
        excludeGoalMarkerCondition(),
      ),
    )
    .orderBy(args.isBefore ? desc(chatEvents.seqId) : asc(chatEvents.seqId))
    .limit(args.limit);
}

async function loadChatSearchContexts(
  db: ReadonlyDb,
  args: {
    readonly matches: readonly ChatSearchMessageRow[];
    readonly before: number;
    readonly after: number;
  },
): Promise<ReadonlyMap<string, ChatSearchContext>> {
  const contextsByMessageId = new Map<string, ChatSearchContext>(
    args.matches.map((match): readonly [string, ChatSearchContext] => {
      return [match.messageId, { before: [], after: [] }];
    }),
  );
  if (args.matches.length === 0 || (args.before === 0 && args.after === 0)) {
    return contextsByMessageId;
  }

  const contextQuery =
    args.before > 0
      ? args.after > 0
        ? chatSearchContextSideQuery(db, {
            isBefore: true,
            limit: args.before,
          }).unionAll(
            chatSearchContextSideQuery(db, {
              isBefore: false,
              limit: args.after,
            }),
          )
        : chatSearchContextSideQuery(db, {
            isBefore: true,
            limit: args.before,
          })
      : chatSearchContextSideQuery(db, {
          isBefore: false,
          limit: args.after,
        });

  const context = contextQuery.as("chat_search_context");
  const resultOrdinality = sql`chat_search_matches.result_ordinality::integer`
    .mapWith(pgIntegerDecoder)
    .as("result_ordinality");
  const rows = await db
    .select({
      resultOrdinality,
      matchedMessageId: matchedChatEvent.id,
      isBefore: context.isBefore,
      messageId: context.messageId,
      chatThreadId: context.chatThreadId,
      eventType: context.eventType,
      content: context.content,
      userMessage: context.userMessage,
      createdAt: context.createdAt,
      seqId: context.seqId,
      sequenceNumber: context.sequenceNumber,
      runId: context.runId,
    })
    .from(
      chatSearchMatchesTable(
        args.matches.map((match) => {
          return match.messageId;
        }),
      ),
    )
    .innerJoin(
      matchedChatEvent,
      eq(matchedChatEvent.id, sql`chat_search_matches.message_id`),
    )
    .crossJoinLateral(context)
    .orderBy(resultOrdinality, asc(context.seqId));

  for (const row of rows) {
    const matchedContext = contextsByMessageId.get(row.matchedMessageId);
    if (!matchedContext) {
      throw new Error(
        "chat search context returned an unknown matched message",
      );
    }
    const message = toChatSearchMessage(row);
    if (row.isBefore) {
      matchedContext.before.push(message);
    } else {
      matchedContext.after.push(message);
    }
  }

  return contextsByMessageId;
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
    const sinceDate = args.since ? new Date(args.since) : undefined;

    const matches = await chatSearchIndexedMatches(db, {
      userId: args.userId,
      orgId: args.orgId,
      eventIds: await chatSearchIndexedEventIds(db, {
        userId: args.userId,
        orgId: args.orgId,
        keyword: args.keyword,
        agentId: args.agentId,
        since: sinceDate,
        limit: args.limit + 1,
      }),
    });

    const hasMore = matches.length > args.limit;
    const truncated = hasMore ? matches.slice(0, args.limit) : matches;

    const contextsByMessageId = await loadChatSearchContexts(db, {
      matches: truncated,
      before: args.before,
      after: args.after,
    });
    const results = truncated.map((match): ChatSearchResult => {
      const context = contextsByMessageId.get(match.messageId);
      if (!context) {
        throw new Error("chat search context is missing a matched message");
      }
      const matchedMessage = toChatSearchMessage(match);
      return {
        chatThreadId: match.chatThreadId,
        agentName: match.agentName,
        matchedMessage,
        matchedRanges: chatSearchMatchRanges(
          matchedMessage.content,
          args.keyword,
        ),
        contextBefore: context.before,
        contextAfter: context.after,
      };
    });

    return { results, hasMore };
  });
}

export function zeroChatThreadEventsPage(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly sinceSeqId: number | undefined;
  readonly beforeSeqId: number | undefined;
  readonly limit: number;
}): Computed<Promise<readonly ChatEvent[] | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [owned] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    if (!owned) {
      return null;
    }

    const cursors = [args.sinceSeqId, args.beforeSeqId].filter((cursor) => {
      return cursor !== undefined;
    });
    if (cursors.length > 1) {
      throw new Error("after and before cursors are mutually exclusive");
    }

    const threadFilter = eq(chatEvents.chatThreadId, args.threadId);
    let rows: ChatEventRow[];

    if (args.sinceSeqId !== undefined) {
      rows = await selectChatEvents(db)
        .where(and(threadFilter, gt(chatEvents.seqId, args.sinceSeqId)))
        .orderBy(asc(chatEvents.seqId))
        .limit(args.limit);
    } else if (args.beforeSeqId !== undefined) {
      rows = (
        await selectChatEvents(db)
          .where(and(threadFilter, lt(chatEvents.seqId, args.beforeSeqId)))
          .orderBy(desc(chatEvents.seqId))
          .limit(args.limit)
      ).reverse();
    } else {
      rows = (
        await selectChatEvents(db)
          .where(threadFilter)
          .orderBy(desc(chatEvents.seqId))
          .limit(args.limit)
      ).reverse();
    }

    return rows.map(toChatEvent);
  });
}

export function zeroChatThreadEventById(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly eventId: string;
}): Computed<Promise<ChatEvent | null>> {
  return computed(async (get) => {
    const owned = await get(ownedChatThread(args.threadId, args.userId));
    if (!owned) {
      return null;
    }

    const db = get(db$);
    const [row] = await selectChatEvents(db)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }

    return toChatEvent(row);
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
        serviceTier: null,
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
