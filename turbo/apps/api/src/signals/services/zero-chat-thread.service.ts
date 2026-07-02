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
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import {
  type HostedArtifactKind,
  hostedArtifactKindSchema,
} from "@vm0/api-contracts/contracts/zero-host";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageUsagePayload,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageRecommendedFollowupGenerationType,
  type ChatMessageRecommendedFollowups,
  type ChatMessageAutomationSnapshot,
  type ChatMessageGoalEvent,
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

import { type Db, db$, writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import {
  inferMimetype,
  insertAssistantEventMessages$,
  resolveAttachFileMetadataUrls,
  resolveAttachFileUrls,
  visibleChatMessageCondition,
} from "./zero-chat-message-shared.service";
import { excludeGoalMarkerCondition } from "./zero-chat-goal-marker.service";
import { cancelRun$, type CancelRunResult } from "./zero-run-cancel.service";
import { buildWorkflowScheduleTriggerBrief } from "./zero-workflow-trigger-brief.service";

export { insertAssistantEventMessages$ };

const messageRoleSchema = z.enum(["user", "assistant"]);
const TERMINAL_MESSAGE_ORDER_SEQUENCE = 2_147_483_647;

function chatMessageOrderSequenceSql() {
  return sql<number>`CASE
    WHEN ${chatMessages.runLifecycleEvent} IS NOT NULL THEN ${TERMINAL_MESSAGE_ORDER_SEQUENCE}
    ELSE COALESCE(${chatMessages.sequenceNumber}, -1)
  END`;
}

type ChatMessageRow = {
  readonly id: string;
  readonly role: string;
  readonly content: string | null;
  readonly thinking: string | null;
  readonly runId: string | null;
  readonly runGroupId: string | null;
  readonly triggerSource: TriggerSource | null;
  readonly isGoalRun: boolean;
  readonly usagePayload: ChatMessageUsagePayload | null;
  readonly runEventId: string | null;
  readonly goalEvent: ChatMessageGoalEvent | null;
  readonly error: string | null;
  readonly runLifecycleEvent: string | null;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly recommendedFollowups: ChatMessageRecommendedFollowups | null;
  readonly automationSnapshot: ChatMessageAutomationSnapshot | null;
  readonly revokesMessageId: string | null;
  readonly interruptsRunId: string | null;
  readonly automationId: string | null;
  readonly automationTitle: string | null;
  readonly workflowName: string | null;
  readonly workflowDisplayName: string | null;
  readonly workflowDescription: string | null;
  readonly workflowId: string | null;
  readonly workflowAgentId: string | null;
  readonly workflowTriggerId: string | null;
  readonly workflowTriggerBrief: string | null;
  readonly workflowTriggerKind: string | null;
  readonly workflowTriggerScheduleType: string | null;
  readonly workflowTriggerCronExpression: string | null;
  readonly workflowTriggerIntervalSeconds: number | null;
  readonly workflowTriggerAtTime: Date | null;
  readonly workflowTriggerTimezone: string | null;
  readonly workflowTriggerUserTimezone: string | null;
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
  readonly pinnedAt: Date | null;
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

const messageColumns = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  thinking: chatMessages.thinking,
  runId: effectiveChatMessageRunId(),
  runGroupId: chatMessages.runGroupId,
  triggerSource: sql<TriggerSource | null>`(
    SELECT "zero_runs"."trigger_source"
    FROM "zero_runs"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  isGoalRun: sql<boolean>`EXISTS (
    SELECT 1
    FROM ${zeroRuns}
    WHERE ${zeroRuns.id} = ${chatMessages.runId}
      AND ${zeroRuns.goalId} IS NOT NULL
  )`,
  usagePayload: chatMessages.usagePayload,
  runEventId: chatMessages.runEventId,
  goalEvent: chatMessages.goalEvent,
  error: chatMessages.error,
  runLifecycleEvent: chatMessages.runLifecycleEvent,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  attachFiles: chatMessages.attachFiles,
  attachFileMetadata: chatMessages.attachFileMetadata,
  generationTemplate: chatMessages.generationTemplate,
  recommendedFollowups: chatMessages.recommendedFollowups,
  automationSnapshot: chatMessages.automationSnapshot,
  revokesMessageId: chatMessages.revokesMessageId,
  interruptsRunId: chatMessages.interruptsRunId,
  automationId: chatMessages.automationId,
  automationTitle: chatMessages.automationTitle,
  workflowId: sql<string | null>`(
    SELECT "zero_workflows"."id"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_triggers"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowAgentId: sql<string | null>`(
    SELECT "zero_workflows"."agent_id"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_triggers"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowName: sql<string | null>`(
    SELECT "zero_workflows"."name"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_triggers"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowDisplayName: sql<string | null>`(
    SELECT "zero_workflows"."display_name"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_triggers"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowDescription: sql<string | null>`(
    SELECT "zero_workflows"."description"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_triggers"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerId: sql<string | null>`(
    SELECT "zero_workflow_triggers"."id"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerBrief: sql<string | null>`(
    SELECT COALESCE(
      "zero_runs"."trigger_brief",
      CASE
        WHEN "zero_workflow_triggers"."kind" = 'event'
          AND "zero_workflow_triggers"."event_type" = 'gmail-label-applied'
          THEN 'Gmail label applied'
        WHEN "zero_workflow_triggers"."kind" = 'event'
          AND "zero_workflow_triggers"."event_type" = 'gmail-new-message'
          THEN 'Gmail new message'
        WHEN "zero_workflow_triggers"."kind" = 'event'
          AND "zero_workflow_triggers"."event_type" = 'google-calendar-event-created'
          THEN 'Google Calendar event created'
        WHEN "zero_workflow_triggers"."kind" = 'event'
          AND "zero_workflow_triggers"."event_type" = 'google-calendar-event-updated'
          THEN 'Google Calendar event updated'
        WHEN "zero_workflow_triggers"."kind" = 'event'
          AND "zero_workflow_triggers"."event_type" = 'google-calendar-event-cancelled'
          THEN 'Google Calendar event cancelled'
        WHEN "zero_workflow_triggers"."kind" = 'event'
          AND "zero_workflow_triggers"."event_type" = 'webhook-received'
          THEN 'Webhook trigger'
        ELSE NULL
      END
    )
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerKind: sql<string | null>`(
    SELECT "zero_workflow_triggers"."kind"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerScheduleType: sql<string | null>`(
    SELECT "zero_workflow_triggers"."schedule_type"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerCronExpression: sql<string | null>`(
    SELECT "zero_workflow_triggers"."cron_expression"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerIntervalSeconds: sql<number | null>`(
    SELECT "zero_workflow_triggers"."interval_seconds"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerAtTime: sql<Date | null>`(
    SELECT "zero_workflow_triggers"."at_time"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerTimezone: sql<string | null>`(
    SELECT "zero_workflow_triggers"."timezone"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
  workflowTriggerUserTimezone: sql<string | null>`(
    SELECT "org_members_metadata"."timezone"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_triggers"
      ON "zero_workflow_triggers"."id" = "zero_runs"."workflow_trigger_id"
    LEFT JOIN "org_members_metadata"
      ON "org_members_metadata"."org_id" = "zero_workflow_triggers"."org_id"
      AND "org_members_metadata"."user_id" = "zero_workflow_triggers"."owner_user_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`,
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
      pinnedAt: thread.pinnedAt ?? null,
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

function workflowScheduleTriggerBrief(row: ChatMessageRow): string | null {
  if (row.workflowTriggerKind !== "schedule") {
    return null;
  }
  return buildWorkflowScheduleTriggerBrief({
    createdAt: row.createdAt,
    scheduleType: row.workflowTriggerScheduleType,
    cronExpression: row.workflowTriggerCronExpression,
    intervalSeconds: row.workflowTriggerIntervalSeconds,
    atTime: row.workflowTriggerAtTime,
    triggerTimezone: row.workflowTriggerTimezone,
    userTimezone: row.workflowTriggerUserTimezone,
  });
}

function workflowSnapshotFromRow(
  row: ChatMessageRow,
): NonNullable<PagedChatMessage["workflowSnapshot"]> | undefined {
  if (row.workflowName === null) {
    return undefined;
  }
  return {
    id: row.workflowId ?? undefined,
    agentId: row.workflowAgentId ?? undefined,
    name: row.workflowName,
    displayName: row.workflowDisplayName,
    description: row.workflowDescription,
    triggerId: row.workflowTriggerId ?? undefined,
    triggerBrief: row.workflowTriggerBrief ?? workflowScheduleTriggerBrief(row),
  };
}

function toPagedMessage(
  userId: string,
  row: ChatMessageRow,
): Computed<Promise<PagedChatMessage>> {
  return computed(async (get): Promise<PagedChatMessage> => {
    const attachFiles = await get(chatMessageAttachFiles(userId, row));
    const workflowSnapshot = workflowSnapshotFromRow(row);

    const role = messageRoleSchema.parse(row.role);
    const message = {
      id: row.id,
      role,
      content: row.content,
      runId: row.runId ?? undefined,
      runGroupId: row.runGroupId ?? undefined,
      triggerSource: row.triggerSource ?? undefined,
      isGoalRun: row.isGoalRun || undefined,
      usage: normalizeUsagePayload(row.usagePayload),
      runEventId: row.runEventId ?? undefined,
      goalEvent: row.goalEvent ?? undefined,
      revokesMessageId: row.revokesMessageId ?? undefined,
      interruptsRunId: row.interruptsRunId ?? undefined,
      error: row.error ?? undefined,
      attachFiles: attachFiles ? [...attachFiles] : undefined,
      generationTemplate: row.generationTemplate ?? undefined,
      sequenceNumber: row.sequenceNumber,
      workflowSnapshot,
      createdAt: row.createdAt.toISOString(),
    };
    if (role !== "assistant") {
      return {
        ...message,
        role: "user" as const,
        automationId: row.automationId ?? undefined,
        automationTitle: row.automationTitle ?? undefined,
        automationSnapshot: row.automationSnapshot ?? undefined,
      };
    }
    return {
      ...message,
      role: "assistant" as const,
      thinking: row.thinking ?? undefined,
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
const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;

function isActiveRunStatus(status: string): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function activeRunStatusSqlList() {
  return sql.join(
    ACTIVE_RUN_STATUSES.map((status) => {
      return sql`${status}`;
    }),
    sql.raw(", "),
  );
}

function noActiveRunsForCurrentThreadCondition() {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${zeroRuns}
    INNER JOIN ${agentRuns} ON ${agentRuns.id} = ${zeroRuns.id}
    WHERE ${zeroRuns.chatThreadId} = ${chatThreads.id}
      AND ${agentRuns.status} IN (${activeRunStatusSqlList()})
  )`;
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
      pinnedAt: thread.pinnedAt?.toISOString() ?? null,
      draftContent: thread.draftContent,
      draftAttachments: thread.draftAttachments
        ? [...thread.draftAttachments]
        : null,
      computerUseHostId: thread.computerUseHostId,
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
        excludeGoalMarkerCondition(),
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
        AND ${agentRuns.status} IN (${activeRunStatusSqlList()})
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
  readonly agentComposeId: string;
  readonly cursor?: string;
  readonly filter?: "unread";
}): Computed<Promise<ChatThreadListPage>> {
  return computed(async (get): Promise<ChatThreadListPage> => {
    const db = get(db$);
    const cursor = decodeChatThreadListCursor(args.cursor);
    const lastMessage =
      args.filter === "unread" ? lastVisibleMessageSubquery(db) : null;

    const projection = chatThreadListProjection();

    const scopedFilters = [
      eq(chatThreads.userId, args.userId),
      eq(zeroAgents.orgId, args.orgId),
      eq(chatThreads.agentComposeId, args.agentComposeId),
    ];
    if (lastMessage) {
      scopedFilters.push(
        isNotNull(lastMessage.id),
        or(
          isNull(chatThreads.lastReadMessageId),
          sql`${chatThreads.lastReadMessageId} <> ${lastMessage.id}`,
        )!,
      );
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
        : lastMessage
          ? db
              .select(projection)
              .from(chatThreads)
              .innerJoin(
                zeroAgents,
                eq(zeroAgents.id, chatThreads.agentComposeId),
              )
              .leftJoinLateral(lastMessage, sql`true`)
              .where(and(...scopedFilters, isNotNull(chatThreads.pinnedAt)))
              .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
          : db
              .select(projection)
              .from(chatThreads)
              .innerJoin(
                zeroAgents,
                eq(zeroAgents.id, chatThreads.agentComposeId),
              )
              .where(and(...scopedFilters, isNotNull(chatThreads.pinnedAt)))
              .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id)),
      lastMessage
        ? db
            .select(projection)
            .from(chatThreads)
            .innerJoin(
              zeroAgents,
              eq(zeroAgents.id, chatThreads.agentComposeId),
            )
            .leftJoinLateral(lastMessage, sql`true`)
            .where(and(...nonPinnedFilters))
            .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
            .limit(SIDEBAR_CHAT_THREAD_LIMIT + 1)
        : db
            .select(projection)
            .from(chatThreads)
            .innerJoin(
              zeroAgents,
              eq(zeroAgents.id, chatThreads.agentComposeId),
            )
            .where(and(...nonPinnedFilters))
            .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
            .limit(SIDEBAR_CHAT_THREAD_LIMIT + 1),
    ]);

    const hasMore = nonPinnedRows.length > SIDEBAR_CHAT_THREAD_LIMIT;
    const pageRows = hasMore
      ? nonPinnedRows.slice(0, SIDEBAR_CHAT_THREAD_LIMIT)
      : nonPinnedRows;
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
 * Agents that currently have at least one unread thread for the user. Uses
 * the same read-cursor comparison as `zeroChatThreadUnreads`.
 */
export function zeroChatThreadUnreadAgentIds(args: {
  readonly userId: string;
  readonly orgId: string;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastMessage = lastVisibleMessageSubquery(db);
    const rows = await db
      .selectDistinct({ agentId: chatThreads.agentComposeId })
      .from(chatThreads)
      .innerJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
      .leftJoinLateral(lastMessage, sql`true`)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          eq(zeroAgents.orgId, args.orgId),
          isNotNull(lastMessage.id),
          or(
            isNull(chatThreads.lastReadMessageId),
            sql`${chatThreads.lastReadMessageId} <> ${lastMessage.id}`,
          ),
          noActiveRunsForCurrentThreadCondition(),
        ),
      );
    return rows.map((row) => {
      return row.agentId;
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
      excludeGoalMarkerCondition(),
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
                    excludeGoalMarkerCondition(),
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
                    excludeGoalMarkerCondition(),
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
    const cursorSequence = chatMessageOrderSequenceSql();
    let rows: ChatMessageRow[];
    let hasHistoryBefore = false;

    if (args.sinceId === undefined && args.beforeId === undefined) {
      const latestRows = await db
        .select(messageColumns)
        .from(chatMessages)
        .where(threadFilter)
        .orderBy(
          desc(chatMessages.createdAt),
          desc(cursorSequence),
          desc(chatMessages.id),
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
        ${cursorSequence},
        ${chatMessages.id}
      ) > (
        SELECT ${chatMessages.createdAt},
          ${chatMessageOrderSequenceSql()},
          ${chatMessages.id}
        FROM ${chatMessages}
        WHERE ${chatMessages.id} = ${cursorId}
          AND ${chatMessages.chatThreadId} = ${args.threadId}
      )`;
      const cursorBeforeCondition = sql`(
        ${chatMessages.createdAt},
        ${cursorSequence},
        ${chatMessages.id}
      ) < (
        SELECT ${chatMessages.createdAt},
          ${chatMessageOrderSequenceSql()},
          ${chatMessages.id}
        FROM ${chatMessages}
        WHERE ${chatMessages.id} = ${cursorId}
          AND ${chatMessages.chatThreadId} = ${args.threadId}
      )`;

      if (args.sinceId !== undefined) {
        rows = await db
          .select(messageColumns)
          .from(chatMessages)
          .where(and(threadFilter, cursorAfterCondition))
          .orderBy(
            asc(chatMessages.createdAt),
            asc(cursorSequence),
            asc(chatMessages.id),
          )
          .limit(args.limit);
      } else {
        const previousRows = await db
          .select(messageColumns)
          .from(chatMessages)
          .where(and(threadFilter, cursorBeforeCondition))
          .orderBy(
            desc(chatMessages.createdAt),
            desc(cursorSequence),
            desc(chatMessages.id),
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

export function zeroChatThreadMessageById(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly messageId: string;
}): Computed<Promise<PagedChatMessage | null>> {
  return computed(async (get) => {
    const owned = await get(ownedChatThread(args.threadId, args.userId));
    if (!owned) {
      return null;
    }

    const db = get(db$);
    const [row] = await db
      .select(messageColumns)
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.id, args.messageId),
          eq(chatMessages.chatThreadId, args.threadId),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }

    return await get(toPagedMessage(args.userId, row));
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
    args: { readonly threadId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<{
    readonly deleted: boolean;
    readonly cancelledRuns: readonly CancelRunResult[];
  }> => {
    const writeDb = set(writeDb$);

    const deletion = await writeDb.transaction(async (tx) => {
      const lockedRows = await tx.execute<{ readonly id: string }>(sql`
        SELECT ${chatThreads.id} AS "id"
        FROM ${chatThreads}
        WHERE ${chatThreads.id} = ${args.threadId}
          AND ${chatThreads.userId} = ${args.userId}
        FOR UPDATE
      `);
      const ownedThread = lockedRows.rows[0];
      if (!ownedThread) {
        return {
          deleted: false,
          activeRuns: [] as readonly ThreadRunToCancel[],
        };
      }

      // Stop related automations first so none of them can spawn a fresh run
      // while we are cancelling the in-flight ones (their triggers cascade).
      await tx
        .delete(automations)
        .where(eq(automations.chatThreadId, ownedThread.id));

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

      // Delete the thread last inside the lock. Cascades chat_messages; captured
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
