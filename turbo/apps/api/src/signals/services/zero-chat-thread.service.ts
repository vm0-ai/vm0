import { command, computed, type Computed } from "ccstate";
import {
  type ArtifactItem,
  type ChatSearchMessage,
  type ChatSearchResult,
  type ChatThreadDraft,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type CodexServiceTier,
  type PagedChatMessage,
  type PersistedAttachment,
  type ResolvedAttachFile,
  type UserMessageDocument,
  persistedAttachmentSchema,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  triggerSourceSchema,
  type TriggerSource,
} from "@vm0/api-contracts/contracts/logs";
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
  chatMessages,
  type ChatMessageUsagePayload,
  type ChatMessageAttachFileMetadata,
  type ChatMessageGenerationTemplate,
  type ChatMessageRecommendedFollowups,
  type ChatMessageStructuredPrompt,
  type ChatMessageGoalEvent,
  type ChatMessageGoalSnapshot,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { userArtifactFavorites } from "@vm0/db/schema/user-artifact-favorite";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { zeroWorkflowAutomations } from "@vm0/db/schema/zero-workflow";
import { alias } from "drizzle-orm/pg-core";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  executeRawRows,
  pgInt8ToSafeIntegerSchema,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import {
  inferMimetype,
  insertAssistantEventMessages$,
  resolveAttachFileMetadataUrls,
  resolveAttachFileUrls,
  visibleChatMessageCondition,
} from "./zero-chat-message-shared.service";
import { normalizeRecommendedFollowups } from "./zero-chat-recommended-followups.service";
import { latestRunFinishMessageSubquery } from "./zero-chat-thread-read-state-query";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";
import { excludeGoalMarkerCondition } from "./zero-chat-goal-marker.service";
import { cancelRun$, type CancelRunResult } from "./zero-run-cancel.service";
import { buildWorkflowScheduleAutomationBrief } from "./zero-workflow-automation-brief.service";
import { excludeCanonicalSlackChatThreads } from "./canonical-slack-web-visibility.service";

export { insertAssistantEventMessages$ };

const messageRoleSchema = z.enum(["user", "assistant"]);
const nullableTriggerSourceDecoder = nullableDriverValueDecoder(
  zodEnumDriverValueDecoder(triggerSourceSchema),
);
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);
const nullableIntegerDecoder = nullableDriverValueDecoder(pgIntegerDecoder);
const nullableTimestampDecoder = nullableDriverValueDecoder(
  zeroWorkflowAutomations.atTime,
);
const TERMINAL_MESSAGE_ORDER_SEQUENCE = 2_147_483_647;
const matchedChatMessage = alias(chatMessages, "matched_chat_message");
const hostedRunUploadedFiles = alias(runUploadedFiles, "hosted_files");
const HOSTED_ARTIFACT_KINDS = ["hosted-site", "presentation-html"] as const;

function chatMessageOrderSequenceSql() {
  return sql`CASE
    WHEN ${isNotNull(chatMessages.runLifecycleEvent)} THEN ${TERMINAL_MESSAGE_ORDER_SEQUENCE}
    ELSE COALESCE(${chatMessages.sequenceNumber}, -1)
  END`;
}

type ChatMessageRow = {
  readonly id: string;
  readonly role: string;
  readonly content: string | null;
  readonly structuredPrompt: ChatMessageStructuredPrompt | null;
  readonly thinking: string | null;
  readonly runId: string | null;
  readonly runGroupId: string | null;
  readonly triggerSource: TriggerSource | null;
  readonly isGoalRun: boolean;
  readonly usagePayload: ChatMessageUsagePayload | null;
  readonly runEventId: string | null;
  readonly goalEvent: ChatMessageGoalEvent | null;
  readonly goalSnapshot: ChatMessageGoalSnapshot | null;
  readonly error: string | null;
  readonly runLifecycleEvent: string | null;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
  readonly recommendedFollowups: ChatMessageRecommendedFollowups | null;
  readonly revokesMessageId: string | null;
  readonly interruptsRunId: string | null;
  readonly workflowName: string | null;
  readonly workflowDisplayName: string | null;
  readonly workflowDescription: string | null;
  readonly workflowId: string | null;
  readonly workflowAgentId: string | null;
  readonly workflowAutomationId: string | null;
  readonly workflowAutomationBrief: string | null;
  readonly workflowAutomationKind: string | null;
  readonly workflowAutomationScheduleType: string | null;
  readonly workflowAutomationCronExpression: string | null;
  readonly workflowAutomationIntervalSeconds: number | null;
  readonly workflowAutomationAtTime: Date | null;
  readonly workflowAutomationTimezone: string | null;
  readonly workflowAutomationUserTimezone: string | null;
};

const artifactListSqlRowSchema = z.object({
  row_id: z.string(),
  run_id: z.string(),
  external_id: z.string(),
  filename: z.string().nullable(),
  content_type: z.string().nullable(),
  size_bytes: pgInt8ToSafeIntegerSchema.nullable(),
  url: z.string(),
  preview_image_url: z.string().nullable(),
  metadata: z.unknown(),
  created_at: pgTimestampWithoutTimezoneToDateSchema,
  updated_at: pgTimestampWithoutTimezoneToDateSchema,
  cursor_created_at: z.string(),
  cursor_updated_at: z.string().optional(),
  thread_id: z.string(),
  thread_title: z.string().nullable(),
  agent_id: z.string(),
  agent_name: z.string().nullable(),
  agent_avatar_url: z.string().nullable(),
});
type ArtifactListSqlRow = z.output<typeof artifactListSqlRowSchema>;

const artifactVisibilityRowSchema = z.object({ visible: z.boolean() });
const artifactSyncUntilRowSchema = z.object({ sync_until: z.string() });

type ChatSearchMessageRow = {
  readonly messageId: string;
  readonly chatThreadId: string;
  readonly role: string;
  readonly content: string | null;
  readonly createdAt: Date;
  readonly sequenceNumber: number | null;
  readonly runId: string | null;
};

interface ChatSearchContext {
  readonly before: ChatSearchMessage[];
  readonly after: ChatSearchMessage[];
}

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentComposeId: string;
  readonly draftContent: string | null;
  readonly draftStructuredPrompt: UserMessageDocument | null;
  readonly draftAttachments: readonly PersistedAttachment[] | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly computerUseHostId: string | null;
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
  readonly computerUseHostId: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
};

function effectiveChatMessageRunId() {
  return chatMessages.runId;
}

const messageColumns = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  structuredPrompt: chatMessages.structuredPrompt,
  thinking: chatMessages.thinking,
  runId: effectiveChatMessageRunId(),
  runGroupId: chatMessages.runGroupId,
  triggerSource: sql`(
    SELECT "zero_runs"."trigger_source"
    FROM "zero_runs"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTriggerSourceDecoder),
  usagePayload: chatMessages.usagePayload,
  runEventId: chatMessages.runEventId,
  goalEvent: chatMessages.goalEvent,
  goalSnapshot: chatMessages.goalSnapshot,
  error: chatMessages.error,
  runLifecycleEvent: chatMessages.runLifecycleEvent,
  sequenceNumber: chatMessages.sequenceNumber,
  createdAt: chatMessages.createdAt,
  attachFiles: chatMessages.attachFiles,
  attachFileMetadata: chatMessages.attachFileMetadata,
  generationTemplate: chatMessages.generationTemplate,
  recommendedFollowups: chatMessages.recommendedFollowups,
  revokesMessageId: chatMessages.revokesMessageId,
  interruptsRunId: chatMessages.interruptsRunId,
  workflowId: sql`(
    SELECT "zero_workflows"."id"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_automations"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAgentId: sql`(
    SELECT "zero_workflows"."agent_id"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_automations"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowName: sql`(
    SELECT "zero_workflows"."name"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_automations"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowDisplayName: sql`(
    SELECT "zero_workflows"."display_name"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_automations"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowDescription: sql`(
    SELECT "zero_workflows"."description"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    INNER JOIN "zero_workflows"
      ON "zero_workflows"."id" = "zero_workflow_automations"."workflow_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationId: sql`(
    SELECT "zero_workflow_automations"."id"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationBrief: sql`(
    SELECT COALESCE(
      "zero_runs"."trigger_brief",
      CASE
        WHEN "zero_workflow_automations"."kind" = 'event'
          AND "zero_workflow_automations"."event_type" = 'gmail-label-applied'
          THEN 'Gmail label applied'
        WHEN "zero_workflow_automations"."kind" = 'event'
          AND "zero_workflow_automations"."event_type" = 'gmail-new-message'
          THEN 'Gmail new message'
        WHEN "zero_workflow_automations"."kind" = 'event'
          AND "zero_workflow_automations"."event_type" = 'google-calendar-event-created'
          THEN 'Google Calendar event created'
        WHEN "zero_workflow_automations"."kind" = 'event'
          AND "zero_workflow_automations"."event_type" = 'google-calendar-event-updated'
          THEN 'Google Calendar event updated'
        WHEN "zero_workflow_automations"."kind" = 'event'
          AND "zero_workflow_automations"."event_type" = 'google-calendar-event-cancelled'
          THEN 'Google Calendar event cancelled'
        WHEN "zero_workflow_automations"."kind" = 'event'
          AND "zero_workflow_automations"."event_type" = 'webhook-received'
          THEN 'Webhook received'
        ELSE NULL
      END
    )
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationKind: sql`(
    SELECT "zero_workflow_automations"."kind"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationScheduleType: sql`(
    SELECT "zero_workflow_automations"."schedule_type"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationCronExpression: sql`(
    SELECT "zero_workflow_automations"."cron_expression"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationIntervalSeconds: sql`(
    SELECT "zero_workflow_automations"."interval_seconds"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableIntegerDecoder),
  workflowAutomationAtTime: sql`(
    SELECT "zero_workflow_automations"."at_time"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTimestampDecoder),
  workflowAutomationTimezone: sql`(
    SELECT "zero_workflow_automations"."timezone"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
  workflowAutomationUserTimezone: sql`(
    SELECT "org_members_metadata"."timezone"
    FROM "zero_runs"
    INNER JOIN "zero_workflow_automations"
      ON "zero_workflow_automations"."id" = "zero_runs"."workflow_automation_id"
    LEFT JOIN "org_members_metadata"
      ON "org_members_metadata"."org_id" = "zero_workflow_automations"."org_id"
      AND "org_members_metadata"."user_id" = "zero_workflow_automations"."owner_user_id"
    WHERE "zero_runs"."id" = "chat_messages"."run_id"
    LIMIT 1
  )`.mapWith(nullableTextDecoder),
} as const;

function selectedMessageColumns(db: Pick<Db, "select">) {
  return {
    ...messageColumns,
    isGoalRun: exists(
      db
        .select({ id: zeroRuns.id })
        .from(zeroRuns)
        .where(
          and(eq(zeroRuns.id, chatMessages.runId), isNotNull(zeroRuns.goalId)),
        ),
    ).mapWith(pgBooleanDecoder),
  } as const;
}

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
        draftStructuredPrompt: chatThreads.draftStructuredPrompt,
        draftAttachments: chatThreads.draftAttachments,
        computerUseHostId: chatThreads.computerUseHostId,
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
      draftContent: thread.draftContent ?? null,
      draftStructuredPrompt: thread.draftStructuredPrompt ?? null,
      draftAttachments: persistedAttachmentSchema
        .array()
        .nullable()
        .parse(thread.draftAttachments ?? null),
      computerUseHostId: thread.computerUseHostId,
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
      draftContent: thread.draftContent,
      draftStructuredPrompt: thread.draftStructuredPrompt,
      draftAttachments: thread.draftAttachments
        ? [...thread.draftAttachments]
        : null,
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

function workflowScheduleAutomationBrief(row: ChatMessageRow): string | null {
  if (row.workflowAutomationKind !== "schedule") {
    return null;
  }
  return buildWorkflowScheduleAutomationBrief({
    createdAt: row.createdAt,
    scheduleType: row.workflowAutomationScheduleType,
    cronExpression: row.workflowAutomationCronExpression,
    intervalSeconds: row.workflowAutomationIntervalSeconds,
    atTime: row.workflowAutomationAtTime,
    automationTimezone: row.workflowAutomationTimezone,
    userTimezone: row.workflowAutomationUserTimezone,
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
    automationId: row.workflowAutomationId ?? undefined,
    triggerBrief:
      row.workflowAutomationBrief ?? workflowScheduleAutomationBrief(row),
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
      goalSnapshot: row.goalSnapshot ?? undefined,
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
        structuredPrompt: row.structuredPrompt ?? undefined,
      };
    }
    const recommendedFollowups = normalizeRecommendedFollowups(
      row.recommendedFollowups,
    );
    return {
      ...message,
      role: "assistant" as const,
      thinking: row.thinking ?? undefined,
      runLifecycleEvent: lifecycleEventOrUndefined(row.runLifecycleEvent),
      recommendedFollowups:
        recommendedFollowups.length > 0 ? recommendedFollowups : undefined,
    };
  });
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
        computerUseHostId: chatThreads.computerUseHostId,
        codexServiceTier: chatThreads.codexServiceTier,
      })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
      .limit(1);

    if (!thread) {
      return null;
    }

    return {
      lastReadAt: thread.lastReadAt,
      computerUseHostId: thread.computerUseHostId,
      codexServiceTier: thread.codexServiceTier ?? null,
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

    return {
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
      computerUseHostId: thread.computerUseHostId,
      codexServiceTier: thread.codexServiceTier,
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
  readonly includeCanonicalSlackThreads?: boolean;
}): Computed<Promise<readonly { threadId: string; unreadAt: string }[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastRunFinish = latestRunFinishMessageSubquery(db, chatThreads.id);
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
          ...(args.includeCanonicalSlackThreads
            ? []
            : [excludeCanonicalSlackChatThreads(db, chatThreads.id)]),
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
  readonly includeCanonicalSlackThreads?: boolean;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get) => {
    const db = get(db$);
    const lastRunFinish = latestRunFinishMessageSubquery(db, chatThreads.id);
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
          ...(args.includeCanonicalSlackThreads
            ? []
            : [excludeCanonicalSlackChatThreads(db, chatThreads.id)]),
        ),
      );
    return rows.map((row) => {
      return row.agentId;
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
  readonly includeCanonicalSlackThreads?: boolean;
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
          ...(args.includeCanonicalSlackThreads
            ? []
            : [excludeCanonicalSlackChatThreads(db, chatThreads.id)]),
        ),
      );

    return rows.flatMap((row) => {
      return row.threadId ? [row.threadId] : [];
    });
  });
}

/**
 * Thread ids owned by the user that currently hold an unsent composer draft
 * (non-empty `draftContent`, a structured prompt, or one+ `draftAttachments`).
 */
export function zeroChatThreadDraftIds(args: {
  readonly userId: string;
  readonly includeCanonicalSlackThreads?: boolean;
}): Computed<Promise<readonly string[]>> {
  return computed(async (get): Promise<readonly string[]> => {
    const db = get(db$);
    const rows = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.userId, args.userId),
          ...(args.includeCanonicalSlackThreads
            ? []
            : [excludeCanonicalSlackChatThreads(db, chatThreads.id)]),
          sql`(
            COALESCE(${chatThreads.draftContent}, '') <> ''
            OR ${isNotNull(chatThreads.draftStructuredPrompt)}
            OR (
              ${isNotNull(chatThreads.draftAttachments)}
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

      const db = get(db$);
      const rows = await db
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
              exists(
                db
                  .select({ id: chatMessages.id })
                  .from(chatMessages)
                  .where(
                    and(
                      eq(chatMessages.runId, runUploadedFiles.runId),
                      eq(chatMessages.chatThreadId, args.threadId),
                    ),
                  ),
              ),
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

function artifactCallerVisibilityConditions(args: {
  readonly userId: string;
  readonly orgId: string;
}): SQL[] {
  return [
    eq(agentRuns.orgId, args.orgId),
    eq(chatThreads.userId, args.userId),
    eq(agentComposes.orgId, args.orgId),
  ];
}

function artifactFileVisibilityConditions(
  db: Pick<Db, "select">,
): (SQL | undefined)[] {
  const hostedArtifactKind = sql`${hostedRunUploadedFiles.metadata}->>'artifactKind'`;
  const artifactKind = sql`${runUploadedFiles.metadata}->>'artifactKind'`;
  return [
    isNotNull(runUploadedFiles.url),
    or(
      notExists(
        db
          .select({ id: hostedRunUploadedFiles.id })
          .from(hostedRunUploadedFiles)
          .where(
            and(
              eq(hostedRunUploadedFiles.runId, runUploadedFiles.runId),
              inArray(hostedArtifactKind, HOSTED_ARTIFACT_KINDS),
            ),
          ),
      ),
      inArray(artifactKind, HOSTED_ARTIFACT_KINDS),
    ),
  ];
}

function artifactVisibilityConditions(
  db: Pick<Db, "select">,
  args: {
    readonly userId: string;
    readonly orgId: string;
  },
): (SQL | undefined)[] {
  return [
    ...artifactCallerVisibilityConditions(args),
    ...artifactFileVisibilityConditions(db),
  ];
}

function toArtifactItem(row: ArtifactListSqlRow): ArtifactItem {
  const filename = row.filename ?? row.external_id;
  const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
  return {
    artifactItemId: `${row.run_id}:${row.external_id}`,
    threadId: row.thread_id,
    runId: row.run_id,
    fileId: row.external_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentAvatarUrl: row.agent_avatar_url,
    threadTitle: row.thread_title,
    filename,
    contentType: row.content_type ?? inferMimetype(filename),
    size: row.size_bytes ?? 0,
    url: row.url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.preview_image_url
      ? { previewImageUrl: row.preview_image_url }
      : {}),
    ...(artifactKind ? { artifactKind } : {}),
  };
}

// Default page size when a caller passes no `limit`. Kept at the historical
// bulk cap so un-paginated callers (older frontend bundles) see the exact same
// first page as before.
const ARTIFACTS_DEFAULT_LIMIT = 10_000;
const ARTIFACTS_MAX_LIMIT = 10_000;
// Re-read a small overlap on every new sync. Artifact writes are idempotently
// merged by artifactItemId in IndexedDB, so replaying rows is safe and closes
// the gap where a transaction starts before syncUntil but commits afterward.
const ARTIFACT_SYNC_REPLAY_WINDOW_MINUTES = 5;

const artifactHistoryCursorSchema = z.object({
  createdAt: z.string(),
  rowId: z.string(),
});
const artifactChangesCursorSchema = z.object({
  updatedAt: z.string(),
  rowId: z.string(),
  syncUntil: z.string(),
});
const artifactCursorSchema = z.union([
  artifactHistoryCursorSchema,
  artifactChangesCursorSchema,
]);
type ArtifactHistoryCursor = z.infer<typeof artifactHistoryCursorSchema>;
type ArtifactChangesCursor = z.infer<typeof artifactChangesCursorSchema>;
type ArtifactCursor = z.infer<typeof artifactCursorSchema>;

function encodeArtifactCursor(cursor: ArtifactCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArtifactCursor(raw: string): ArtifactCursor {
  return artifactCursorSchema.parse(
    JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
  );
}

interface ZeroArtifactsArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly updatedAfter?: string;
}

interface ZeroArtifactsResult {
  readonly artifacts: readonly ArtifactItem[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly syncUntil: string;
}

async function artifactSyncUntil(db: Db): Promise<string> {
  const rows = await executeRawRows(
    db,
    sql`SELECT to_char(
      clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) AS sync_until`,
    artifactSyncUntilRowSchema,
  );
  const row = rows[0];
  if (!row) {
    throw new Error("Failed to read artifact sync timestamp");
  }
  return row.sync_until;
}

function toArtifactChangesPage(args: {
  readonly rows: readonly ArtifactListSqlRow[];
  readonly limit: number;
  readonly syncUntil: string;
}): ZeroArtifactsResult {
  const hasMore = args.rows.length > args.limit;
  const pageRows = hasMore ? args.rows.slice(0, args.limit) : args.rows;
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow?.cursor_updated_at
      ? encodeArtifactCursor({
          updatedAt: lastRow.cursor_updated_at,
          rowId: lastRow.row_id,
          syncUntil: args.syncUntil,
        })
      : null;

  return {
    artifacts: pageRows.map(toArtifactItem),
    truncated: hasMore,
    nextCursor,
    syncUntil: args.syncUntil,
  };
}

async function listChangedArtifacts(args: {
  readonly db: Db;
  readonly query: ZeroArtifactsArgs;
  readonly limit: number;
  readonly cursor: ArtifactChangesCursor | null;
  readonly updatedAfter: string;
  readonly syncUntil: string;
  readonly signal: AbortSignal;
}): Promise<ZeroArtifactsResult> {
  // Metadata returned with an artifact can change without changing the file
  // row itself. Treat the latest source timestamp as the artifact's effective
  // update time so cross-device thread and agent edits are synchronized too.
  const effectiveUpdatedAt = sql`GREATEST(
    ${runUploadedFiles.updatedAt},
    visible_runs.metadata_updated_at
  )`;
  const lowerBoundClause = args.cursor
    ? sql`(${effectiveUpdatedAt}, ${runUploadedFiles.id}) > (${args.cursor.updatedAt}::timestamptz AT TIME ZONE 'UTC', ${args.cursor.rowId}::uuid)`
    : sql`${effectiveUpdatedAt} >= (${args.updatedAfter}::timestamptz AT TIME ZONE 'UTC') - (${ARTIFACT_SYNC_REPLAY_WINDOW_MINUTES} * interval '1 minute')`;
  const callerConditions = artifactCallerVisibilityConditions(args.query);
  const fileConditions = artifactFileVisibilityConditions(args.db);
  const rows = await executeRawRows(
    args.db,
    sql`
      WITH visible_runs AS MATERIALIZED (
        SELECT
          ${agentRuns.id} AS run_id,
          GREATEST(
            ${chatThreads.updatedAt},
            ${agentComposes.updatedAt},
            ${zeroAgents.updatedAt}
          ) AS metadata_updated_at
        FROM ${agentRuns}
        INNER JOIN ${zeroRuns}
          ON ${eq(zeroRuns.id, agentRuns.id)}
        INNER JOIN ${chatThreads}
          ON ${chatThreads.id} = COALESCE(
            ${zeroRuns.chatThreadId},
            (
              SELECT ${chatMessages.chatThreadId}
              FROM ${chatMessages}
              WHERE ${eq(chatMessages.runId, zeroRuns.id)}
              ORDER BY ${asc(chatMessages.createdAt)}
              LIMIT 1
            )
          )
        INNER JOIN ${agentComposes}
          ON ${eq(agentComposes.id, chatThreads.agentComposeId)}
        INNER JOIN ${zeroAgents}
          ON ${eq(zeroAgents.id, agentComposes.id)}
        WHERE ${sql.join(callerConditions, sql` AND `)}
      ),
      changed_artifact_ids AS MATERIALIZED (
        SELECT
          ${runUploadedFiles.id} AS row_id,
          ${effectiveUpdatedAt} AS effective_updated_at
        FROM visible_runs
        INNER JOIN ${runUploadedFiles}
          ON ${runUploadedFiles.runId} = visible_runs.run_id
        WHERE ${sql.join(fileConditions, sql` AND `)}
          AND ${lowerBoundClause}
          AND ${lt(effectiveUpdatedAt, sql`${args.syncUntil}::timestamptz AT TIME ZONE 'UTC'`)}
        ORDER BY ${asc(effectiveUpdatedAt)}, ${asc(runUploadedFiles.id)}
        LIMIT ${args.limit + 1}
      )
      SELECT
        ${runUploadedFiles.id} AS row_id,
        ${runUploadedFiles.runId} AS run_id,
        ${runUploadedFiles.externalId} AS external_id,
        ${runUploadedFiles.filename} AS filename,
        ${runUploadedFiles.contentType} AS content_type,
        ${runUploadedFiles.sizeBytes} AS size_bytes,
        ${runUploadedFiles.url} AS url,
        ${runUploadedFiles.previewImageUrl} AS preview_image_url,
        ${runUploadedFiles.metadata} AS metadata,
        ${runUploadedFiles.createdAt} AS created_at,
        ${runUploadedFiles.updatedAt} AS updated_at,
        to_char(
          ${runUploadedFiles.createdAt},
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at,
        to_char(
          changed_artifact_ids.effective_updated_at,
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_updated_at,
        ${chatThreads.id} AS thread_id,
        ${chatThreads.title} AS thread_title,
        ${zeroAgents.id} AS agent_id,
        COALESCE(${zeroAgents.displayName}, ${agentComposes.name}) AS agent_name,
        ${zeroAgents.avatarUrl} AS agent_avatar_url
      FROM changed_artifact_ids
      INNER JOIN ${runUploadedFiles}
        ON ${runUploadedFiles.id} = changed_artifact_ids.row_id
      INNER JOIN ${agentRuns}
        ON ${eq(agentRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${zeroRuns}
        ON ${eq(zeroRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${chatThreads}
        ON ${chatThreads.id} = COALESCE(
          ${zeroRuns.chatThreadId},
          (
            SELECT ${chatMessages.chatThreadId}
            FROM ${chatMessages}
            WHERE ${eq(chatMessages.runId, runUploadedFiles.runId)}
            ORDER BY ${asc(chatMessages.createdAt)}
            LIMIT 1
          )
        )
      INNER JOIN ${agentComposes}
        ON ${eq(agentComposes.id, chatThreads.agentComposeId)}
      INNER JOIN ${zeroAgents}
        ON ${eq(zeroAgents.id, agentComposes.id)}
      ORDER BY changed_artifact_ids.effective_updated_at ASC,
        changed_artifact_ids.row_id ASC
    `,
    artifactListSqlRowSchema,
  );
  args.signal.throwIfAborted();
  return toArtifactChangesPage({ rows, ...args });
}

async function listArtifactHistory(args: {
  readonly db: Db;
  readonly query: ZeroArtifactsArgs;
  readonly limit: number;
  readonly cursor: ArtifactHistoryCursor | null;
  readonly syncUntil: string;
  readonly signal: AbortSignal;
}): Promise<ZeroArtifactsResult> {
  // The full path returns raw visible rows. IndexedDB owns stable-ID merging
  // and hosted-run shadowing, so this query avoids a history-wide URL sort.
  const keysetClause = args.cursor
    ? sql`AND (${runUploadedFiles.createdAt}, ${runUploadedFiles.id}) < (${args.cursor.createdAt}::timestamptz AT TIME ZONE 'UTC', ${args.cursor.rowId}::uuid)`
    : sql.empty();
  const conditions = artifactVisibilityConditions(args.db, args.query);
  const rows = await executeRawRows(
    args.db,
    sql`
      SELECT
        ${runUploadedFiles.id} AS row_id,
        ${runUploadedFiles.runId} AS run_id,
        ${runUploadedFiles.externalId} AS external_id,
        ${runUploadedFiles.filename} AS filename,
        ${runUploadedFiles.contentType} AS content_type,
        ${runUploadedFiles.sizeBytes} AS size_bytes,
        ${runUploadedFiles.url} AS url,
        ${runUploadedFiles.previewImageUrl} AS preview_image_url,
        ${runUploadedFiles.metadata} AS metadata,
        ${runUploadedFiles.createdAt} AS created_at,
        ${runUploadedFiles.updatedAt} AS updated_at,
        ${chatThreads.id} AS thread_id,
        ${chatThreads.title} AS thread_title,
        ${zeroAgents.id} AS agent_id,
        COALESCE(${zeroAgents.displayName}, ${agentComposes.name}) AS agent_name,
        ${zeroAgents.avatarUrl} AS agent_avatar_url,
        to_char(
          ${runUploadedFiles.createdAt},
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS cursor_created_at
      FROM ${runUploadedFiles}
      INNER JOIN ${agentRuns}
        ON ${eq(agentRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${zeroRuns}
        ON ${eq(zeroRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${chatThreads}
        ON ${chatThreads.id} = COALESCE(
          ${zeroRuns.chatThreadId},
          (
            SELECT ${chatMessages.chatThreadId}
            FROM ${chatMessages}
            WHERE ${eq(chatMessages.runId, runUploadedFiles.runId)}
            ORDER BY ${asc(chatMessages.createdAt)}
            LIMIT 1
          )
        )
      INNER JOIN ${agentComposes}
        ON ${eq(agentComposes.id, chatThreads.agentComposeId)}
      INNER JOIN ${zeroAgents}
        ON ${eq(zeroAgents.id, agentComposes.id)}
      WHERE ${sql.join(conditions, sql` AND `)}
      ${keysetClause}
    ORDER BY ${desc(runUploadedFiles.createdAt)}, ${desc(runUploadedFiles.id)}
      LIMIT ${args.limit + 1}
    `,
    artifactListSqlRowSchema,
  );
  args.signal.throwIfAborted();

  const hasMore = rows.length > args.limit;
  const pageRows = hasMore ? rows.slice(0, args.limit) : rows;
  const lastRow = pageRows.at(-1);
  const nextCursor =
    hasMore && lastRow
      ? encodeArtifactCursor({
          createdAt: lastRow.cursor_created_at,
          rowId: lastRow.row_id,
        })
      : null;

  return {
    artifacts: pageRows.map(toArtifactItem),
    truncated: hasMore,
    nextCursor,
    syncUntil: args.syncUntil,
  };
}

interface ArtifactFavoriteArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly artifactUrl: string;
}

interface ArtifactFavoriteScope {
  readonly userId: string;
  readonly orgId: string;
}

export const zeroArtifacts$ = command(
  async (
    { set },
    args: ZeroArtifactsArgs,
    signal: AbortSignal,
  ): Promise<ZeroArtifactsResult> => {
    const db = set(writeDb$);
    const limit = Math.min(
      args.limit ?? ARTIFACTS_DEFAULT_LIMIT,
      ARTIFACTS_MAX_LIMIT,
    );
    const cursor = args.cursor ? decodeArtifactCursor(args.cursor) : null;
    const changesCursor = cursor && "updatedAt" in cursor ? cursor : null;
    const syncUntil = changesCursor?.syncUntil ?? (await artifactSyncUntil(db));
    const updatedAfter = changesCursor?.updatedAt ?? args.updatedAfter;
    if (updatedAfter !== undefined) {
      return await listChangedArtifacts({
        db,
        query: args,
        limit,
        cursor: changesCursor,
        updatedAfter,
        syncUntil,
        signal,
      });
    }

    return await listArtifactHistory({
      db,
      query: args,
      limit,
      cursor: cursor && "createdAt" in cursor ? cursor : null,
      syncUntil,
      signal,
    });
  },
);

export const artifactFavoriteUrls$ = command(
  async (
    { set },
    args: ArtifactFavoriteScope,
    signal: AbortSignal,
  ): Promise<string[]> => {
    const rows = await set(writeDb$)
      .select({ artifactUrl: userArtifactFavorites.artifactUrl })
      .from(userArtifactFavorites)
      .where(
        and(
          eq(userArtifactFavorites.orgId, args.orgId),
          eq(userArtifactFavorites.userId, args.userId),
        ),
      )
      .orderBy(asc(userArtifactFavorites.artifactUrl));
    signal.throwIfAborted();
    return rows.map((row) => {
      return row.artifactUrl;
    });
  },
);

async function artifactUrlIsVisible(
  db: Pick<Db, "execute" | "select">,
  args: ArtifactFavoriteArgs,
): Promise<boolean> {
  const conditions = [
    ...artifactVisibilityConditions(db, args),
    eq(runUploadedFiles.url, args.artifactUrl),
  ];
  const rows = await executeRawRows(
    db,
    sql`
      SELECT EXISTS (
      SELECT 1
      FROM ${runUploadedFiles}
      INNER JOIN ${agentRuns}
        ON ${eq(agentRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${zeroRuns}
        ON ${eq(zeroRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${chatThreads}
        ON ${chatThreads.id} = COALESCE(
          ${zeroRuns.chatThreadId},
          (
            SELECT ${chatMessages.chatThreadId}
            FROM ${chatMessages}
            WHERE ${eq(chatMessages.runId, runUploadedFiles.runId)}
            ORDER BY ${asc(chatMessages.createdAt)}
            LIMIT 1
          )
        )
      INNER JOIN ${agentComposes}
        ON ${eq(agentComposes.id, chatThreads.agentComposeId)}
      WHERE ${sql.join(conditions, sql` AND `)}
      LIMIT 1
      ) AS visible
    `,
    artifactVisibilityRowSchema,
  );
  return rows[0]?.visible === true;
}

export const favoriteArtifact$ = command(
  async (
    { set },
    args: ArtifactFavoriteArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const visible = await db.transaction(async (tx) => {
      if (!(await artifactUrlIsVisible(tx, args))) {
        return false;
      }

      await tx
        .insert(userArtifactFavorites)
        .values({
          orgId: args.orgId,
          userId: args.userId,
          artifactUrl: args.artifactUrl,
        })
        .onConflictDoNothing({
          target: [
            userArtifactFavorites.orgId,
            userArtifactFavorites.userId,
            userArtifactFavorites.artifactUrl,
          ],
        });
      return true;
    });
    signal.throwIfAborted();
    return visible;
  },
);

export const unfavoriteArtifact$ = command(
  async (
    { set },
    args: ArtifactFavoriteArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(userArtifactFavorites)
      .where(
        and(
          eq(userArtifactFavorites.orgId, args.orgId),
          eq(userArtifactFavorites.userId, args.userId),
          eq(userArtifactFavorites.artifactUrl, args.artifactUrl),
        ),
      );
    signal.throwIfAborted();
  },
);

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
      ...searchMessageColumns,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, matchedChatMessage.chatThreadId),
        args.isBefore
          ? lt(chatMessages.createdAt, matchedChatMessage.createdAt)
          : gt(chatMessages.createdAt, matchedChatMessage.createdAt),
        isNotNull(chatMessages.content),
        visibleChatMessageCondition(db),
        excludeGoalMarkerCondition(),
      ),
    )
    .orderBy(
      args.isBefore
        ? desc(chatMessages.createdAt)
        : asc(chatMessages.createdAt),
    )
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
      matchedMessageId: matchedChatMessage.id,
      isBefore: context.isBefore,
      messageId: context.messageId,
      chatThreadId: context.chatThreadId,
      role: context.role,
      content: context.content,
      createdAt: context.createdAt,
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
      matchedChatMessage,
      sql`${matchedChatMessage.id} = chat_search_matches.message_id`,
    )
    .crossJoinLateral(context)
    .orderBy(resultOrdinality, asc(context.createdAt));

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
  readonly includeCanonicalSlackThreads?: boolean;
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
      visibleChatMessageCondition(db),
      excludeGoalMarkerCondition(),
      ilike(chatMessages.content, pattern),
      ...(args.includeCanonicalSlackThreads
        ? []
        : [excludeCanonicalSlackChatThreads(db, chatThreads.id)]),
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
      return {
        chatThreadId: match.chatThreadId,
        agentName: match.agentName,
        matchedMessage: toChatSearchMessage(match),
        contextBefore: context.before,
        contextAfter: context.after,
      };
    });

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
        .select(selectedMessageColumns(db))
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
        WHERE ${eq(chatMessages.id, cursorId)}
          AND ${eq(chatMessages.chatThreadId, args.threadId)}
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
        WHERE ${eq(chatMessages.id, cursorId)}
          AND ${eq(chatMessages.chatThreadId, args.threadId)}
      )`;

      if (args.sinceId !== undefined) {
        rows = await db
          .select(selectedMessageColumns(db))
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
          .select(selectedMessageColumns(db))
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
      .select(selectedMessageColumns(db))
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
      readonly draftStructuredPrompt: UserMessageDocument | null;
      readonly draftAttachments: readonly PersistedAttachment[] | null;
    },
    signal: AbortSignal,
  ): Promise<{ readonly updated: boolean }> => {
    const writeDb = set(writeDb$);

    const updated = await writeDb
      .update(chatThreads)
      .set({
        draftContent: args.draftContent,
        draftStructuredPrompt: args.draftStructuredPrompt,
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
