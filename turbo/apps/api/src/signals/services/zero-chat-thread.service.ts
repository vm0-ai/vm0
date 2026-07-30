import { command, computed, type Computed } from "ccstate";
import {
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import {
  chatEventResponse,
  type ArtifactItem,
  type ChatSearchMessage,
  type ChatSearchResult,
  type ChatThreadDraft,
  type ChatThreadArtifactRun,
  type ChatThreadDetail,
  type CodexServiceTier,
  type ChatEvent,
  type ChatEventResponse,
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
  chatEvents,
  type ChatEventUsagePayload,
  type ChatEventGenerationTemplate,
  type ChatEventRecommendedFollowups,
  type ChatEventUserMessage,
  type ChatEventGoalEvent,
  type ChatEventGoalSnapshot,
} from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import {
  CANONICAL_ASSET_ACCESS_LEVELS,
  CANONICAL_ASSET_CLASSIFICATIONS,
  CANONICAL_ASSET_MATERIALIZATION_STATUSES,
  CANONICAL_ASSET_VERSION,
  chatEventAssetRefs,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
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
  not,
  notExists,
  or,
  type SQL,
  type SQLWrapper,
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
  pgInt8ToSafeIntegerDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import { type Db, db$, type ReadonlyDb, writeDb$ } from "../external/db";
import {
  inferMimetype,
  insertAssistantEvents$,
  resolveAttachFileUrls,
  visibleChatEventCondition,
} from "./zero-chat-event-shared.service";
import { normalizeRecommendedFollowups } from "./zero-chat-recommended-followups.service";
import { latestRunFinishEventSubquery } from "./zero-chat-thread-read-state-query";
import { appendChatThreadEvent } from "./zero-chat-thread-event.service";
import { excludeGoalMarkerCondition } from "./zero-chat-goal-marker.service";
import { cancelRun$, type CancelRunResult } from "./zero-run-cancel.service";
import { buildWorkflowScheduleAutomationBrief } from "./zero-workflow-automation-brief.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

export { insertAssistantEvents$ };

const nullableTriggerSourceDecoder = nullableDriverValueDecoder(
  zodEnumDriverValueDecoder(triggerSourceSchema),
);
const nullableTextDecoder = nullableDriverValueDecoder(pgTextDecoder);
const matchedChatEvent = alias(chatEvents, "matched_chat_event");
const revokedChatEvent = alias(chatEvents, "revoked_chat_event");
const hostedRunUploadedFiles = alias(runUploadedFiles, "hosted_files");
const HOSTED_ARTIFACT_KINDS = ["hosted-site", "presentation-html"] as const;

type ChatEventRow = {
  readonly id: string;
  readonly chatThreadId: string;
  readonly eventType: ChatEventType;
  readonly content: string | null;
  readonly userMessage: ChatEventUserMessage | null;
  readonly thinking: string | null;
  readonly runId: string | null;
  readonly runGroupId: string | null;
  readonly automationId: string | null;
  readonly triggerSource: TriggerSource | null;
  readonly triggerBrief: string | null;
  readonly slackMessagePermalink: string | null;
  readonly feishuChatOpenUrl: string | null;
  readonly isGoalRun: boolean;
  readonly usagePayload: ChatEventUsagePayload | null;
  readonly runEventId: string | null;
  readonly goalEvent: ChatEventGoalEvent | null;
  readonly goalSnapshot: ChatEventGoalSnapshot | null;
  readonly error: string | null;
  readonly runLifecycleEvent: string | null;
  readonly seqId: number;
  readonly sequenceNumber: number | null;
  readonly createdAt: Date;
  readonly attachFiles: readonly string[] | null;
  readonly generationTemplate: ChatEventGenerationTemplate | null;
  readonly recommendedFollowups: ChatEventRecommendedFollowups | null;
  readonly revokesEventId: string | null;
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

const canonicalAssetClassificationSchema = z.enum(
  CANONICAL_ASSET_CLASSIFICATIONS,
);
const canonicalAssetAccessLevelSchema = z.enum(CANONICAL_ASSET_ACCESS_LEVELS);
const canonicalAssetMaterializationStatusSchema = z.enum(
  CANONICAL_ASSET_MATERIALIZATION_STATUSES,
);
const canonicalAssetMaterializationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
const canonicalAssetProvenanceSchema = z.object({
  provider: z.string(),
});

const artifactListSqlRowSchema = z.object({
  row_id: z.string(),
  asset_version: z.number().nullable(),
  run_id: z.string(),
  external_id: z.string(),
  filename: z.string().nullable(),
  content_type: z.string().nullable(),
  size_bytes: pgInt8ToSafeIntegerSchema.nullable(),
  url: z.string(),
  preview_image_url: z.string().nullable(),
  metadata: z.unknown(),
  classification: canonicalAssetClassificationSchema.nullable(),
  access_level: canonicalAssetAccessLevelSchema.nullable(),
  materialization_status: canonicalAssetMaterializationStatusSchema.nullable(),
  materialization_error: canonicalAssetMaterializationErrorSchema.nullable(),
  provenance: canonicalAssetProvenanceSchema.nullable(),
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

type ArtifactListRow = Omit<ArtifactListSqlRow, "url"> & {
  readonly url: string | null;
};

const nullableCanonicalAssetClassificationDecoder = nullableDriverValueDecoder(
  zodEnumDriverValueDecoder(canonicalAssetClassificationSchema),
);
const nullableCanonicalAssetAccessLevelDecoder = nullableDriverValueDecoder(
  zodEnumDriverValueDecoder(canonicalAssetAccessLevelSchema),
);
const nullableCanonicalAssetMaterializationStatusDecoder =
  nullableDriverValueDecoder(
    zodEnumDriverValueDecoder(canonicalAssetMaterializationStatusSchema),
  );
const nullableCanonicalAssetMaterializationErrorDecoder =
  nullableDriverValueDecoder(
    zodDriverValueDecoder(canonicalAssetMaterializationErrorSchema),
  );
const nullableCanonicalAssetProvenanceDecoder = nullableDriverValueDecoder(
  zodDriverValueDecoder(canonicalAssetProvenanceSchema),
);

const artifactSyncUntilRowSchema = z.object({ sync_until: z.string() });

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

interface ChatSearchContext {
  readonly before: ChatSearchMessage[];
  readonly after: ChatSearchMessage[];
}

type ChatThreadRow = {
  readonly id: string;
  readonly title: string | null;
  readonly agentComposeId: string;
  readonly draftUserMessage: UserMessageDocument | null;
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
  return chatEvents.runId;
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
  automationId: chatEvents.automationId,
  triggerBrief: chatEvents.triggerBrief,
  usagePayload: chatEvents.usagePayload,
  runEventId: chatEvents.runEventId,
  goalEvent: chatEvents.goalEvent,
  goalSnapshot: chatEvents.goalSnapshot,
  error: chatEvents.error,
  runLifecycleEvent: chatEvents.runLifecycleEvent,
  seqId: chatEvents.seqId,
  sequenceNumber: chatEvents.sequenceNumber,
  createdAt: chatEvents.createdAt,
  attachFiles: chatEvents.attachFiles,
  generationTemplate: chatEvents.generationTemplate,
  recommendedFollowups: chatEvents.recommendedFollowups,
  revokesEventId: chatEvents.revokesEventId,
  interruptsRunId: chatEvents.interruptsRunId,
} as const;

function chatEventMetadataSubquery(db: Pick<Db, "select">) {
  return db
    .select({
      runTriggerSource: sql`${zeroRuns.triggerSource}`
        .mapWith(nullableTriggerSourceDecoder)
        .as("run_trigger_source"),
      workflowId: sql`${zeroWorkflows.id}`
        .mapWith(zeroWorkflows.id)
        .as("workflow_id"),
      workflowAgentId: zeroWorkflows.agentId,
      workflowName: zeroWorkflows.name,
      workflowDisplayName: zeroWorkflows.displayName,
      workflowDescription: zeroWorkflows.description,
      workflowAutomationId: sql`${zeroWorkflowAutomations.id}`
        .mapWith(zeroWorkflowAutomations.id)
        .as("workflow_automation_id"),
      workflowAutomationBrief: sql`CASE
        WHEN ${isNull(zeroWorkflowAutomations.id)} THEN NULL
        ELSE COALESCE(
          ${zeroRuns.triggerBrief},
          CASE
            WHEN ${eq(zeroWorkflowAutomations.kind, "event")} THEN CASE
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "chat-run-finished",
              )} THEN 'Chat run finished'
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "gmail-label-applied",
              )} THEN 'Gmail label applied'
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "gmail-new-message",
              )} THEN 'Gmail new message'
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "google-calendar-event-created",
              )} THEN 'Google Calendar event created'
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "google-calendar-event-updated",
              )} THEN 'Google Calendar event updated'
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "google-calendar-event-cancelled",
              )} THEN 'Google Calendar event cancelled'
              WHEN ${eq(
                zeroWorkflowAutomations.eventType,
                "webhook-received",
              )} THEN 'Webhook received'
              ELSE NULL
            END
            ELSE NULL
          END
        )
      END`
        .mapWith(nullableTextDecoder)
        .as("workflow_automation_brief"),
      workflowAutomationKind: zeroWorkflowAutomations.kind,
      workflowAutomationScheduleType: zeroWorkflowAutomations.scheduleType,
      workflowAutomationCronExpression: zeroWorkflowAutomations.cronExpression,
      workflowAutomationIntervalSeconds:
        zeroWorkflowAutomations.intervalSeconds,
      workflowAutomationAtTime: zeroWorkflowAutomations.atTime,
      workflowAutomationTimezone: zeroWorkflowAutomations.timezone,
      workflowAutomationUserTimezone: sql`${orgMembersMetadata.timezone}`
        .mapWith(orgMembersMetadata.timezone)
        .as("workflow_automation_user_timezone"),
      goalId: zeroRuns.goalId,
    })
    .from(zeroRuns)
    .leftJoin(
      zeroWorkflowAutomations,
      eq(zeroWorkflowAutomations.id, zeroRuns.workflowAutomationId),
    )
    .leftJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .leftJoin(
      orgMembersMetadata,
      and(
        eq(orgMembersMetadata.orgId, zeroWorkflowAutomations.orgId),
        eq(orgMembersMetadata.userId, zeroWorkflowAutomations.ownerUserId),
      ),
    )
    .where(eq(zeroRuns.id, chatEvents.runId))
    .limit(1)
    .as("chat_event_metadata");
}

function selectChatEventsWithMetadata(db: Pick<Db, "select">) {
  const metadata = chatEventMetadataSubquery(db);
  return db
    .select({
      ...eventColumns,
      triggerSource: sql`COALESCE(
        ${chatEvents.triggerSource},
        ${metadata.runTriggerSource}
      )`
        .mapWith(nullableTriggerSourceDecoder)
        .as("trigger_source"),
      slackMessagePermalink: sql`COALESCE(
        ${chatEvents.slackMessagePermalink},
        ${revokedChatEvent.slackMessagePermalink}
      )`
        .mapWith(nullableTextDecoder)
        .as("slack_message_permalink"),
      feishuChatOpenUrl: sql`COALESCE(
        ${chatEvents.feishuChatOpenUrl},
        ${revokedChatEvent.feishuChatOpenUrl}
      )`
        .mapWith(nullableTextDecoder)
        .as("feishu_chat_open_url"),
      workflowId: metadata.workflowId,
      workflowAgentId: metadata.workflowAgentId,
      workflowName: metadata.workflowName,
      workflowDisplayName: metadata.workflowDisplayName,
      workflowDescription: metadata.workflowDescription,
      workflowAutomationId: metadata.workflowAutomationId,
      workflowAutomationBrief: metadata.workflowAutomationBrief,
      workflowAutomationKind: metadata.workflowAutomationKind,
      workflowAutomationScheduleType: metadata.workflowAutomationScheduleType,
      workflowAutomationCronExpression:
        metadata.workflowAutomationCronExpression,
      workflowAutomationIntervalSeconds:
        metadata.workflowAutomationIntervalSeconds,
      workflowAutomationAtTime: metadata.workflowAutomationAtTime,
      workflowAutomationTimezone: metadata.workflowAutomationTimezone,
      workflowAutomationUserTimezone: metadata.workflowAutomationUserTimezone,
      isGoalRun: isNotNull(metadata.goalId).mapWith(pgBooleanDecoder),
    })
    .from(chatEvents)
    .leftJoinLateral(metadata, sql`true`)
    .leftJoin(
      revokedChatEvent,
      eq(revokedChatEvent.id, chatEvents.revokesEventId),
    );
}

const searchMessageColumns = {
  messageId: chatEvents.id,
  chatThreadId: chatEvents.chatThreadId,
  eventType: chatEvents.eventType,
  content: chatEvents.content,
  userMessage: chatEvents.userMessage,
  createdAt: chatEvents.createdAt,
  seqId: chatEvents.seqId,
  sequenceNumber: chatEvents.sequenceNumber,
  runId: effectiveChatEventRunId(),
} as const;

const searchContextMessageColumns = {
  ...searchMessageColumns,
  eventType: sql`${chatEvents.eventType}`
    .mapWith(chatEvents.eventType)
    .as("context_event_type"),
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

function parseHostedArtifactAliasUrlFromMetadata(
  metadata: unknown,
): string | undefined {
  if (!isRecord(metadata) || typeof metadata.aliasUrl !== "string") {
    return undefined;
  }
  return metadata.aliasUrl;
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
      draftContent: null,
      draftUserMessage: thread.draftUserMessage,
      draftAttachments: thread.draftAttachments
        ? [...thread.draftAttachments]
        : null,
    };
  });
}

function privateCanonicalAssetUrl(assetId: string): string {
  return `/api/zero/web/download-file?file_id=${encodeURIComponent(assetId)}`;
}

function canonicalAssetMaterialization(
  status: "pending" | "ready" | "failed" | null,
  error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null,
): NonNullable<ResolvedAttachFile["assetRef"]>["materialization"] {
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

async function canonicalEventAttachments(
  db: ReadonlyDb,
  userId: string,
  eventIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ResolvedAttachFile[]>> {
  if (eventIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      eventId: chatEventAssetRefs.chatEventId,
      position: chatEventAssetRefs.position,
      assetId: runUploadedFiles.id,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      sizeBytes: runUploadedFiles.sizeBytes,
      status: runUploadedFiles.materializationStatus,
      error: runUploadedFiles.materializationError,
      provenance: runUploadedFiles.provenance,
      source: runUploadedFiles.source,
      externalId: runUploadedFiles.externalId,
      url: runUploadedFiles.url,
      classification: runUploadedFiles.classification,
      accessLevel: runUploadedFiles.accessLevel,
    })
    .from(chatEventAssetRefs)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, chatEventAssetRefs.assetId),
    )
    .where(
      and(
        inArray(chatEventAssetRefs.chatEventId, [...eventIds]),
        eq(runUploadedFiles.userId, userId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
        or(
          and(
            eq(runUploadedFiles.classification, "input"),
            eq(runUploadedFiles.accessLevel, "private"),
          ),
          and(
            eq(runUploadedFiles.classification, "published-output"),
            eq(runUploadedFiles.accessLevel, "published"),
          ),
        ),
      ),
    )
    .orderBy(
      asc(chatEventAssetRefs.chatEventId),
      asc(chatEventAssetRefs.position),
    );

  const byEvent = new Map<string, ResolvedAttachFile[]>();
  for (const row of rows) {
    const filename = row.filename ?? row.assetId;
    const isPublishedOutput =
      row.classification === "published-output" &&
      row.accessLevel === "published";
    const attachments = byEvent.get(row.eventId) ?? [];
    attachments.push({
      id:
        !isPublishedOutput && row.source === "web"
          ? row.externalId
          : row.assetId,
      filename,
      contentType: row.contentType ?? inferMimetype(filename),
      size: row.sizeBytes ?? 0,
      url:
        isPublishedOutput && row.url
          ? row.url
          : row.source === "web" && row.url
            ? row.url
            : privateCanonicalAssetUrl(row.assetId),
      assetRef: {
        id: row.assetId,
        classification: isPublishedOutput ? "published-output" : "input",
        access: isPublishedOutput ? "published" : "private",
        materialization: canonicalAssetMaterialization(row.status, row.error),
        ...(row.provenance
          ? { provenance: { provider: row.provenance.provider } }
          : {}),
      },
    });
    byEvent.set(row.eventId, attachments);
  }
  return byEvent;
}

function chatEventAttachFiles(
  userId: string,
  row: ChatEventRow,
  canonicalAttachments: readonly ResolvedAttachFile[],
): Computed<Promise<readonly ResolvedAttachFile[] | undefined>> {
  return computed(async (get) => {
    if (canonicalAttachments.length > 0) {
      return canonicalAttachments;
    }
    if (row.attachFiles && row.attachFiles.length > 0) {
      return await get(resolveAttachFileUrls(userId, row.attachFiles));
    }
    return undefined;
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

function workflowScheduleAutomationBrief(row: ChatEventRow): string | null {
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
  row: ChatEventRow,
): NonNullable<ChatEvent["workflowSnapshot"]> | undefined {
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

function baseChatEventFromRow(
  row: ChatEventRow,
  workflowSnapshot: NonNullable<ChatEvent["workflowSnapshot"]> | undefined,
  content: string | null,
) {
  return {
    id: row.id,
    threadId: row.chatThreadId,
    content,
    runId: row.runId ?? undefined,
    runGroupId: row.runGroupId ?? undefined,
    triggerSource: row.triggerSource ?? undefined,
    slackMessagePermalink: row.slackMessagePermalink ?? undefined,
    feishuChatOpenUrl: row.feishuChatOpenUrl ?? undefined,
    isGoalRun: row.isGoalRun || undefined,
    runEventId: row.runEventId ?? undefined,
    goalSnapshot: row.goalSnapshot ?? undefined,
    revokesEventId: row.revokesEventId ?? undefined,
    seqId: row.seqId,
    sequenceNumber: row.sequenceNumber,
    workflowSnapshot,
    createdAt: row.createdAt.toISOString(),
  };
}

type ChatEventBase = ReturnType<typeof baseChatEventFromRow>;
type ChatEventBuilder = (
  row: ChatEventRow,
  event: ChatEventBase,
  attachFiles: readonly ResolvedAttachFile[] | undefined,
) => ChatEventResponse;

const chatEventBuilders = {
  "input.prompt": (row, event, attachFiles) => {
    return {
      ...event,
      eventType: "input.prompt",
      content: null,
      userMessage: requiredChatEventField(
        row.userMessage,
        row.eventType,
        "userMessage",
      ),
      attachFiles: attachFiles ? [...attachFiles] : undefined,
      generationTemplate: row.generationTemplate ?? undefined,
    };
  },
  "input.automation": (row, event) => {
    return {
      ...event,
      eventType: "input.automation",
      content: null,
      automationId: requiredChatEventField(
        row.automationId,
        row.eventType,
        "automationId",
      ),
      triggerSource: requiredChatEventField(
        row.triggerSource,
        row.eventType,
        "triggerSource",
      ),
      triggerBrief: row.triggerBrief,
    };
  },
  "input.goal": (row, event) => {
    return {
      id: event.id,
      threadId: event.threadId,
      eventType: "input.goal",
      content: null,
      goalSnapshot: requiredChatEventField(
        row.goalSnapshot,
        row.eventType,
        "goalSnapshot",
      ),
      seqId: event.seqId,
      createdAt: event.createdAt,
    };
  },
  "input.rejected": (row, event, attachFiles) => {
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
      automationId: row.automationId ?? undefined,
      triggerBrief: row.automationId === null ? undefined : row.triggerBrief,
      attachFiles: attachFiles ? [...attachFiles] : undefined,
      generationTemplate: row.generationTemplate ?? undefined,
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
    const recommendedFollowups = requiredChatEventField(
      row.recommendedFollowups,
      row.eventType,
      "recommendedFollowups",
    );
    return {
      ...event,
      eventType: "output.followups",
      content: null,
      recommendedFollowups: normalizeRecommendedFollowups(recommendedFollowups),
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
  "run.completed": (row, event, attachFiles) => {
    return {
      ...event,
      eventType: "run.completed",
      runId: requiredChatEventField(row.runId, row.eventType, "runId"),
      attachFiles: attachFiles ? [...attachFiles] : undefined,
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
  "goal.changed": (row, event) => {
    return {
      ...event,
      eventType: "goal.changed",
      content: null,
      goalEvent: requiredChatEventField(
        row.goalEvent,
        row.eventType,
        "goalEvent",
      ),
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
  // Historical rows from the retired queue pause/resume behavior. These have
  // no writer anymore but still occupy seqIds, so the read path serves them
  // as-is instead of filtering and leaving holes in the event stream.
  "queue.automation_paused": (row, event) => {
    return {
      ...event,
      eventType: "queue.automation_paused",
      content: null,
      pauseReason: row.error ?? null,
    };
  },
  "queue.automation_resumed": (_row, event) => {
    return {
      ...event,
      eventType: "queue.automation_resumed",
      content: null,
    };
  },
} satisfies Record<ChatEventResponse["eventType"], ChatEventBuilder>;

function toChatEvent(
  userId: string,
  row: ChatEventRow,
  canonicalAttachments: readonly ResolvedAttachFile[],
): Computed<Promise<ChatEventResponse>> {
  return computed(async (get): Promise<ChatEventResponse> => {
    const attachFiles = await get(
      chatEventAttachFiles(userId, row, canonicalAttachments),
    );
    const event = chatEventBuilders[row.eventType](
      row,
      baseChatEventFromRow(row, workflowSnapshotFromRow(row), row.content),
      attachFiles,
    );
    return chatEventResponse(event);
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

    return {
      lastReadAt: thread.lastReadAt?.toISOString() ?? null,
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

function artifactCallerVisibilityConditions(args: {
  readonly userId: string;
  readonly orgId: string;
}): readonly [SQL, SQL, SQL] {
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

function artifactChatThreadId(db: Pick<Db, "select">, runId: SQLWrapper): SQL {
  const earliestThread = db
    .select({ threadId: chatEvents.chatThreadId })
    .from(chatEvents)
    .where(eq(chatEvents.runId, runId))
    .orderBy(asc(chatEvents.seqId))
    .limit(1);

  return sql`COALESCE(${zeroRuns.chatThreadId}, (${earliestThread}))`;
}

function toArtifactItem(row: ArtifactListRow): ArtifactItem {
  if (row.url === null) {
    throw new Error(
      "artifact list invariant violated: URL is null despite isNotNull filter",
    );
  }

  const filename = row.filename ?? row.external_id;
  const artifactKind = parseHostedArtifactKindFromMetadata(row.metadata);
  const canonical =
    row.asset_version === CANONICAL_ASSET_VERSION &&
    row.classification === "published-output" &&
    row.access_level === "published";
  return {
    artifactItemId: canonical
      ? `asset:${row.row_id}`
      : `${row.run_id}:${row.external_id}`,
    threadId: row.thread_id,
    runId: row.run_id,
    fileId: canonical ? row.row_id : row.external_id,
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
    ...(canonical
      ? {
          assetRef: {
            id: row.row_id,
            classification: "published-output" as const,
            access: "published" as const,
            materialization: canonicalAssetMaterialization(
              row.materialization_status,
              row.materialization_error,
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
    ? gt(
        sql`(${effectiveUpdatedAt}, ${runUploadedFiles.id})`,
        sql`(${args.cursor.updatedAt}::timestamptz AT TIME ZONE 'UTC', ${args.cursor.rowId}::uuid)`,
      )
    : gte(
        effectiveUpdatedAt,
        sql`(${args.updatedAfter}::timestamptz AT TIME ZONE 'UTC') - (${ARTIFACT_SYNC_REPLAY_WINDOW_MINUTES} * interval '1 minute')`,
      );
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
          ON ${eq(chatThreads.id, artifactChatThreadId(args.db, zeroRuns.id))}
        INNER JOIN ${agentComposes}
          ON ${eq(agentComposes.id, chatThreads.agentComposeId)}
        INNER JOIN ${zeroAgents}
          ON ${eq(zeroAgents.id, agentComposes.id)}
        WHERE ${and(...artifactCallerVisibilityConditions(args.query))}
      ),
      changed_artifact_ids AS MATERIALIZED (
        SELECT
          ${runUploadedFiles.id} AS row_id,
          ${effectiveUpdatedAt} AS effective_updated_at
        FROM visible_runs
        INNER JOIN ${runUploadedFiles}
          ON ${eq(runUploadedFiles.runId, sql`visible_runs.run_id`)}
        WHERE ${and(
          ...fileConditions,
          lowerBoundClause,
          lt(
            effectiveUpdatedAt,
            sql`${args.syncUntil}::timestamptz AT TIME ZONE 'UTC'`,
          ),
        )}
        ORDER BY ${asc(effectiveUpdatedAt)}, ${asc(runUploadedFiles.id)}
        LIMIT ${args.limit + 1}
      )
      SELECT
        ${runUploadedFiles.id} AS row_id,
        ${runUploadedFiles.assetVersion} AS asset_version,
        ${runUploadedFiles.runId} AS run_id,
        ${runUploadedFiles.externalId} AS external_id,
        ${runUploadedFiles.filename} AS filename,
        ${runUploadedFiles.contentType} AS content_type,
        ${runUploadedFiles.sizeBytes} AS size_bytes,
        ${runUploadedFiles.url} AS url,
        ${runUploadedFiles.previewImageUrl} AS preview_image_url,
        ${runUploadedFiles.metadata} AS metadata,
        ${runUploadedFiles.classification} AS classification,
        ${runUploadedFiles.accessLevel} AS access_level,
        ${runUploadedFiles.materializationStatus} AS materialization_status,
        ${runUploadedFiles.materializationError} AS materialization_error,
        ${runUploadedFiles.provenance} AS provenance,
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
        ON ${eq(runUploadedFiles.id, sql`changed_artifact_ids.row_id`)}
      INNER JOIN ${agentRuns}
        ON ${eq(agentRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${zeroRuns}
        ON ${eq(zeroRuns.id, runUploadedFiles.runId)}
      INNER JOIN ${chatThreads}
        ON ${eq(
          chatThreads.id,
          artifactChatThreadId(args.db, runUploadedFiles.runId),
        )}
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
  // The full path returns visible rows. IndexedDB owns stable-ID merging and
  // hosted-run shadowing, so this query avoids a history-wide URL sort.
  const keysetCondition = args.cursor
    ? lt(
        sql`(${runUploadedFiles.createdAt}, ${runUploadedFiles.id})`,
        sql`(${args.cursor.createdAt}::timestamptz AT TIME ZONE 'UTC', ${args.cursor.rowId}::uuid)`,
      )
    : undefined;
  const conditions = artifactVisibilityConditions(args.db, args.query);
  const rows: ArtifactListRow[] = await args.db
    .select({
      row_id: runUploadedFiles.id,
      asset_version: runUploadedFiles.assetVersion,
      run_id: agentRuns.id,
      external_id: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      content_type: runUploadedFiles.contentType,
      size_bytes: sql`${runUploadedFiles.sizeBytes}`
        .mapWith(nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder))
        .as("size_bytes"),
      url: runUploadedFiles.url,
      preview_image_url: runUploadedFiles.previewImageUrl,
      metadata: runUploadedFiles.metadata,
      classification: sql`${runUploadedFiles.classification}`
        .mapWith(nullableCanonicalAssetClassificationDecoder)
        .as("classification"),
      access_level: sql`${runUploadedFiles.accessLevel}`
        .mapWith(nullableCanonicalAssetAccessLevelDecoder)
        .as("access_level"),
      materialization_status: sql`${runUploadedFiles.materializationStatus}`
        .mapWith(nullableCanonicalAssetMaterializationStatusDecoder)
        .as("materialization_status"),
      materialization_error: sql`${runUploadedFiles.materializationError}`
        .mapWith(nullableCanonicalAssetMaterializationErrorDecoder)
        .as("materialization_error"),
      provenance: sql`${runUploadedFiles.provenance}`
        .mapWith(nullableCanonicalAssetProvenanceDecoder)
        .as("provenance"),
      created_at: runUploadedFiles.createdAt,
      updated_at: runUploadedFiles.updatedAt,
      thread_id: chatThreads.id,
      thread_title: chatThreads.title,
      agent_id: zeroAgents.id,
      agent_name:
        sql`COALESCE(${zeroAgents.displayName}, ${agentComposes.name})`
          .mapWith(nullableTextDecoder)
          .as("agent_name"),
      agent_avatar_url: zeroAgents.avatarUrl,
      cursor_created_at: sql`to_char(
        ${runUploadedFiles.createdAt},
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )`
        .mapWith(pgTextDecoder)
        .as("cursor_created_at"),
    })
    .from(runUploadedFiles)
    .innerJoin(agentRuns, eq(agentRuns.id, runUploadedFiles.runId))
    .innerJoin(zeroRuns, eq(zeroRuns.id, runUploadedFiles.runId))
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, artifactChatThreadId(args.db, runUploadedFiles.runId)),
    )
    .innerJoin(agentComposes, eq(agentComposes.id, chatThreads.agentComposeId))
    .innerJoin(zeroAgents, eq(zeroAgents.id, agentComposes.id))
    .where(and(...conditions, keysetCondition))
    .orderBy(desc(runUploadedFiles.createdAt), desc(runUploadedFiles.id))
    .limit(args.limit + 1);
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

function chatSearchMessageTextCondition(): SQL {
  return or(
    and(
      chatEventTypeIn(["input.prompt", "input.rejected"]),
      isNotNull(chatEvents.userMessage),
    ),
    and(
      not(chatEventTypeIn(["input.prompt", "input.rejected"])),
      isNotNull(chatEvents.content),
    ),
  ) as SQL;
}

function userMessageSearchText(): SQL {
  return sql`concat_ws(
    ' ',
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].text')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].titleSnapshot')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].nameSnapshot')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].filenameSnapshot')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].quote')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].note[*].text')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].note[*].titleSnapshot')::text,
    jsonb_path_query_array(${chatEvents.userMessage}, '$.parts[*].note[*].nameSnapshot')::text
  )`;
}

function chatSearchKeywordCondition(pattern: string): SQL {
  return or(
    and(
      chatEventTypeIn(["input.prompt", "input.rejected"]),
      ilike(userMessageSearchText(), pattern),
    ),
    and(
      not(chatEventTypeIn(["input.prompt", "input.rejected"])),
      ilike(chatEvents.content, pattern),
    ),
  ) as SQL;
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
        chatSearchMessageTextCondition(),
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
    const pattern = `%${escapeLikePattern(args.keyword)}%`;
    const sinceDate = args.since ? new Date(args.since) : undefined;

    const matchConditions = [
      eq(chatThreads.userId, args.userId),
      eq(agentComposes.orgId, args.orgId),
      chatSearchMessageTextCondition(),
      visibleChatEventCondition(db),
      excludeGoalMarkerCondition(),
      chatSearchKeywordCondition(pattern),
    ];
    if (sinceDate) {
      matchConditions.push(gte(chatEvents.createdAt, sinceDate));
    }
    if (args.agentId) {
      matchConditions.push(eq(zeroAgents.id, args.agentId));
    }

    const matches = await db
      .select({
        ...searchMessageColumns,
        agentName: agentComposes.name,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatEvents.chatThreadId, chatThreads.id))
      .innerJoin(
        agentComposes,
        eq(chatThreads.agentComposeId, agentComposes.id),
      )
      .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
      .where(and(...matchConditions))
      .orderBy(desc(chatEvents.createdAt))
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

export function zeroChatThreadEventsPage(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly sinceSeqId: number | undefined;
  readonly beforeSeqId: number | undefined;
  readonly sinceId: string | undefined;
  readonly beforeId: string | undefined;
  readonly limit: number;
}): Computed<Promise<readonly ChatEventResponse[] | null>> {
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

    const cursors = [
      args.sinceSeqId,
      args.beforeSeqId,
      args.sinceId,
      args.beforeId,
    ].filter((cursor) => {
      return cursor !== undefined;
    });
    if (cursors.length > 1) {
      throw new Error("after and before cursors are mutually exclusive");
    }

    // Previous browser bundles use UUID cursors. Resolve them to the immutable
    // per-thread sequence until those clients can no longer remain active.
    const legacyCursorId = args.sinceId ?? args.beforeId;
    const [legacyCursor] =
      legacyCursorId === undefined
        ? []
        : await db
            .select({ seqId: chatEvents.seqId })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.id, legacyCursorId),
                eq(chatEvents.chatThreadId, args.threadId),
              ),
            )
            .limit(1);
    if (legacyCursorId !== undefined && !legacyCursor) {
      return [];
    }

    const sinceSeqId =
      args.sinceSeqId ?? (args.sinceId ? legacyCursor?.seqId : undefined);
    const beforeSeqId =
      args.beforeSeqId ?? (args.beforeId ? legacyCursor?.seqId : undefined);
    const threadFilter = eq(chatEvents.chatThreadId, args.threadId);
    let rows: ChatEventRow[];

    if (sinceSeqId !== undefined) {
      rows = await selectChatEventsWithMetadata(db)
        .where(and(threadFilter, gt(chatEvents.seqId, sinceSeqId)))
        .orderBy(asc(chatEvents.seqId))
        .limit(args.limit);
    } else if (beforeSeqId !== undefined) {
      rows = (
        await selectChatEventsWithMetadata(db)
          .where(and(threadFilter, lt(chatEvents.seqId, beforeSeqId)))
          .orderBy(desc(chatEvents.seqId))
          .limit(args.limit)
      ).reverse();
    } else {
      rows = (
        await selectChatEventsWithMetadata(db)
          .where(threadFilter)
          .orderBy(desc(chatEvents.seqId))
          .limit(args.limit)
      ).reverse();
    }

    return await get(
      chatEventsWithAssets({
        userId: args.userId,
        rows,
      }),
    );
  });
}

function chatEventsWithAssets(args: {
  readonly userId: string;
  readonly rows: readonly ChatEventRow[];
}): Computed<Promise<readonly ChatEventResponse[]>> {
  return computed(async (get) => {
    const canonicalByEvent = await canonicalEventAttachments(
      get(db$),
      args.userId,
      args.rows.map((row) => {
        return row.id;
      }),
    );
    return await Promise.all(
      args.rows.map((row) => {
        return get(
          toChatEvent(args.userId, row, canonicalByEvent.get(row.id) ?? []),
        );
      }),
    );
  });
}

export function zeroChatThreadEventById(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly eventId: string;
}): Computed<Promise<ChatEventResponse | null>> {
  return computed(async (get) => {
    const owned = await get(ownedChatThread(args.threadId, args.userId));
    if (!owned) {
      return null;
    }

    const db = get(db$);
    const [row] = await selectChatEventsWithMetadata(db)
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

    const [event] = await get(
      chatEventsWithAssets({
        userId: args.userId,
        rows: [row],
      }),
    );
    return event ?? null;
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
      readonly draftUserMessage: UserMessageDocument | null;
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
