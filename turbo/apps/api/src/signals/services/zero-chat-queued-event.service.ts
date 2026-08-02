import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import type { ChatEventType } from "@vm0/api-contracts/contracts/chat-events";
import { command } from "ccstate";
import { chatAutomationContext } from "@vm0/db/schema/chat-automation-context";
import { chatGoalContext } from "@vm0/db/schema/chat-goal-context";
import { chatEventInputParams } from "@vm0/db/schema/chat-event-input-params";
import {
  chatEvents,
  type ChatEventAttachFileMetadata,
  type ChatEventGenerationTemplate,
  type ChatEventUserMessage,
} from "@vm0/db/schema/chat-event";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
import { threadGoals } from "@vm0/db/schema/thread-goal";
import {
  zeroWorkflowAutomations,
  zeroWorkflows,
} from "@vm0/db/schema/zero-workflow";
import {
  and,
  asc,
  eq,
  exists,
  isNull,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  pgBooleanDecoder,
  pgNullDecoder,
} from "../../lib/db-structured-result";
import { db$, type Db } from "../external/db";
import {
  chatQueueEventPriority,
  listPendingChatQueueEvents,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
  pendingChatQueueEventCondition,
} from "./chat-event-queue.service";
import {
  insertChatEvent,
  type LoadedChatEventReplacementTarget,
  type NewChatEvent,
  revokeChatEvent,
  replaceLoadedChatEvent,
  replaceChatEvent,
} from "./zero-chat-event.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-event-shared.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  decryptPersistentSecretsMap,
  encryptPersistentSecretsMap,
} from "./crypto.utils";
import { noGoalChangeAfterQueueEvent } from "./chat-goal-queue.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";
import { resolveArtifactObject$ } from "./artifact-storage.service";
import { attachCanonicalWebInputAssetsToEvent } from "./canonical-asset.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const USER_MESSAGE_QUEUE_RUN_PARAMS_KEY = "__user_message_queue_run_params__";
const queuedUserMessageTriggerSourceSchema = z.enum([
  "web",
  "slack",
  "feishu",
  "teams",
  "telegram",
  "agentphone",
  "github",
  "workflow-schedule",
]);

const queuedUserMessageRunParamsSchema = z.object({
  version: z.literal(1),
});

type QueuedUserMessageRunParams = z.infer<
  typeof queuedUserMessageRunParamsSchema
>;

const queuedChatEvent = alias(chatEvents, "queued_chat_event");
const queuedChatEventRevoker = alias(chatEvents, "queued_chat_event_revoker");
const queuedEncryptedParams = chatEventInputParams.encryptedParams;
const queueFirstReplacementTargetFields = {
  id: chatEvents.id,
  chatThreadId: chatEvents.chatThreadId,
  createdAt: chatEvents.createdAt,
  eventType: chatEvents.eventType,
  contextType: chatEvents.contextType,
  contextId: chatEvents.contextId,
  encryptedParams: queuedEncryptedParams,
} as const;

export interface QueuedUserMessage {
  readonly id: string;
  readonly createdAt: Date;
  readonly userMessage: ChatEventUserMessage;
  readonly attachFiles: readonly string[] | null;
  readonly generationTemplate: ChatEventGenerationTemplate | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly triggerSource:
    | "web"
    | "slack"
    | "feishu"
    | "teams"
    | "telegram"
    | "agentphone"
    | "github"
    | "workflow-schedule";
  readonly encryptedParams: string | null;
}

export type QueueFirstRunAssociation =
  | {
      readonly kind: "user_message";
      readonly threadId: string;
      readonly eventId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly admissionTime: number;
      readonly attachFileMetadata:
        | readonly ChatEventAttachFileMetadata[]
        | null;
      readonly morningBriefDeliveryId?: string;
    }
  | {
      readonly kind: "workflow_event";
      readonly threadId: string;
      readonly eventId: string;
      readonly prompt: string;
      readonly runGroupId: string;
    }
  | {
      readonly kind: "goal_event";
      readonly threadId: string;
      readonly eventId: string;
      readonly prompt: string;
      readonly goalId: string;
      readonly orgId: string;
      readonly userId: string;
    };

export type QueueFirstRunClaimResult =
  | {
      readonly kind: "claimed";
      readonly createdAt: Date;
      readonly morningBriefDeliveryId?: string;
    }
  | { readonly kind: "lost" };

export type QueueFirstRunAdmission =
  | { readonly kind: "blocked" }
  | { readonly kind: "idle" };

export type QueueFirstRunSessionSnapshotState =
  | "binding_changed"
  | "current"
  | "session_changed"
  | "unvalidated";

/**
 * Establish the thread-first lock order shared by every event-backed queue
 * claim, rejection, and revocation.
 */
export async function lockUserMessageQueueThread(
  db: Db,
  threadId: string,
): Promise<boolean> {
  return await lockChatQueueThread(db, threadId);
}

export async function encryptQueuedUserMessageRunParams(
  params: QueuedUserMessageRunParams,
  ctx: { readonly orgId: string; readonly userId: string },
): Promise<string> {
  const encrypted = await encryptPersistentSecretsMap(
    { [USER_MESSAGE_QUEUE_RUN_PARAMS_KEY]: JSON.stringify(params) },
    ctx,
  );
  if (!encrypted) {
    throw new Error("Failed to encrypt queued user message run params");
  }
  return encrypted;
}

export async function decryptQueuedUserMessageRunParams(
  encryptedParams: string | null,
  ctx: { readonly orgId: string; readonly userId: string },
): Promise<QueuedUserMessageRunParams | null> {
  if (!encryptedParams) {
    return null;
  }
  const decrypted = await decryptPersistentSecretsMap(encryptedParams, ctx);
  const raw = decrypted?.[USER_MESSAGE_QUEUE_RUN_PARAMS_KEY];
  if (!raw) {
    return null;
  }
  return queuedUserMessageRunParamsSchema.parse(JSON.parse(raw) as unknown);
}

export const resolveAttachFileMetadata$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly attachFiles: readonly string[] | null;
    },
    signal: AbortSignal,
  ): Promise<ChatEventAttachFileMetadata[] | null> => {
    if (!args.attachFiles || args.attachFiles.length === 0) {
      return null;
    }
    const db = get(db$);
    const metadata: ChatEventAttachFileMetadata[] = [];
    for (const id of args.attachFiles) {
      const [object, [asset]] = await Promise.all([
        set(resolveArtifactObject$, { userId: args.userId, id }, signal),
        db
          .select({
            filename: runUploadedFiles.filename,
            contentType: runUploadedFiles.contentType,
            size: runUploadedFiles.sizeBytes,
          })
          .from(runUploadedFiles)
          .where(
            and(
              eq(runUploadedFiles.userId, args.userId),
              eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
              eq(runUploadedFiles.idempotencyScope, "web-input"),
              eq(runUploadedFiles.idempotencyKey, id),
            ),
          )
          .limit(1),
      ]);
      signal.throwIfAborted();
      if (!object) {
        throw new Error(`Queued attachment not found: ${id}`);
      }
      metadata.push({
        id,
        filename: asset?.filename ?? object.filename,
        contentType: asset?.contentType ?? object.contentType,
        size: asset?.size ?? object.size,
        objectKey: object.key,
      });
    }
    return metadata;
  },
);

/** Whether the outer ChatEvent row is an unclaimed, unrevoked prompt. */
export function queuedUserMessageExists(db: Pick<Db, "select">): SQL {
  return exists(
    db
      .select({ id: queuedChatEvent.id })
      .from(queuedChatEvent)
      .where(
        and(
          eq(queuedChatEvent.id, chatEvents.id),
          eq(queuedChatEvent.eventType, "input.prompt" satisfies ChatEventType),
          isNull(queuedChatEvent.runId),
          notExists(
            db
              .select({ id: queuedChatEventRevoker.id })
              .from(queuedChatEventRevoker)
              .where(
                eq(queuedChatEventRevoker.revokesEventId, queuedChatEvent.id),
              ),
          ),
        ),
      ),
  );
}

export async function loadNextUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
  queueItemCreatedBefore?: Date,
): Promise<QueuedUserMessage | null> {
  const pending = await listPendingChatQueueEvents(
    db,
    threadId,
    queueItemCreatedBefore,
  );
  const head = pending[0];
  if (!head || head.eventType !== "input.prompt") {
    return null;
  }
  const [event] = await db
    .select({
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      userMessage: chatEvents.userMessage,
      attachFiles: chatEvents.attachFiles,
      generationTemplate: chatEvents.generationTemplate,
      modelProviderId: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderType: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderCredentialScope: sql`NULL`.mapWith(pgNullDecoder),
      selectedModel: chatThreads.selectedModel,
      triggerSource: chatEvents.triggerSource,
      encryptedParams: queuedEncryptedParams,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(
      and(
        eq(chatEvents.id, head.id),
        eq(chatEvents.chatThreadId, threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatEvents.runId),
      ),
    )
    .limit(1);
  if (!event) {
    return null;
  }
  if (!event.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const triggerSource = queuedUserMessageTriggerSourceSchema.safeParse(
    event.triggerSource,
  );
  // Legacy rows have no typed payload until the cutover migration backfills
  // them. They remain pending (and keep automation behind them) without making
  // a code-before-migration deploy fail.
  if (!triggerSource.success) {
    return null;
  }
  return {
    ...event,
    userMessage: event.userMessage,
    triggerSource: triggerSource.data,
  };
}

export async function loadNextUnclaimedQueuedUserMessageId(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const [head] = await listPendingChatQueueEvents(db, threadId);
  return head?.eventType === "input.prompt" ? head.id : null;
}

type QueueFirstClaimArgs = QueueFirstRunAssociation & {
  readonly admission: QueueFirstRunAdmission;
  readonly runId: string;
  readonly timing: ApiDispatchTimingCollector;
};

interface QueueFirstClaimSnapshot {
  readonly target: LoadedChatEventReplacementTarget;
  readonly replacement: NewChatEvent;
}

function replacementTargetFromQueueHead(
  head: LoadedChatEventReplacementTarget,
): LoadedChatEventReplacementTarget {
  return {
    id: head.id,
    chatThreadId: head.chatThreadId,
    createdAt: head.createdAt,
    eventType: head.eventType,
    contextType: head.contextType,
    contextId: head.contextId,
    encryptedParams: head.encryptedParams,
  };
}

async function resolveUserQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: Extract<QueueFirstClaimArgs, { readonly kind: "user_message" }>,
): Promise<QueueFirstClaimSnapshot | null> {
  const [head] = await db
    .select({
      ...queueFirstReplacementTargetFields,
      userMessage: chatEvents.userMessage,
      attachFiles: chatEvents.attachFiles,
      generationTemplate: chatEvents.generationTemplate,
      triggerSource: chatEvents.triggerSource,
    })
    .from(chatEvents)
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        pendingChatQueueEventCondition(db),
      ),
    )
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (!head || head.eventType !== "input.prompt" || head.id !== args.eventId) {
    return null;
  }
  if (!head.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  return {
    target: replacementTargetFromQueueHead(head),
    replacement: {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage: head.userMessage,
      runId: args.runId,
      attachFiles: head.attachFiles ? [...head.attachFiles] : null,
      generationTemplate: head.generationTemplate,
      ...(head.triggerSource ? { triggerSource: head.triggerSource } : {}),
    },
  };
}

async function resolveWorkflowQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: Extract<QueueFirstClaimArgs, { readonly kind: "workflow_event" }>,
): Promise<QueueFirstClaimSnapshot | null> {
  const [head] = await db
    .select({
      ...queueFirstReplacementTargetFields,
      automationId: chatAutomationContext.automationId,
      triggerSource: chatEvents.triggerSource,
      triggerBrief: chatAutomationContext.triggerBrief,
      userMessage: chatEvents.userMessage,
      workflowId: zeroWorkflows.id,
      workflowName: zeroWorkflows.name,
    })
    .from(chatEvents)
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .leftJoin(
      chatAutomationContext,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatAutomationContext.id, chatEvents.contextId),
      ),
    )
    .leftJoin(
      zeroWorkflowAutomations,
      eq(zeroWorkflowAutomations.id, chatAutomationContext.automationId),
    )
    .leftJoin(
      zeroWorkflows,
      eq(zeroWorkflows.id, zeroWorkflowAutomations.workflowId),
    )
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        pendingChatQueueEventCondition(db),
      ),
    )
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (
    !head ||
    head.eventType !== "input.automation" ||
    head.id !== args.eventId ||
    head.automationId !== args.runGroupId
  ) {
    return null;
  }
  const userMessage =
    head.userMessage ??
    (head.workflowName === null
      ? null
      : createUserMessageDocument({
          text: null,
          nonContentPart: {
            type: "automation",
            workflowName: head.workflowName,
            ...(head.workflowId === null
              ? {}
              : { workflowId: head.workflowId }),
            ...(head.triggerBrief === null
              ? {}
              : { automationBrief: head.triggerBrief }),
          },
        }));
  if (!userMessage) {
    throw new Error("Workflow queue event is missing its user message");
  }
  return {
    target: replacementTargetFromQueueHead(head),
    replacement: {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage,
      runId: args.runId,
      runGroupId: args.runGroupId,
      ...(head.triggerSource ? { triggerSource: head.triggerSource } : {}),
    },
  };
}

async function resolveGoalQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: Extract<QueueFirstClaimArgs, { readonly kind: "goal_event" }>,
): Promise<QueueFirstClaimSnapshot | null> {
  const [head] = await db
    .select({
      ...queueFirstReplacementTargetFields,
      goalId: threadGoals.id,
      goalStatus: threadGoals.status,
      goalSnapshotCurrent:
        noGoalChangeAfterQueueEvent(db).mapWith(pgBooleanDecoder),
      userMessage: chatEvents.userMessage,
      goalBrief: chatGoalContext.objectiveBrief,
    })
    .from(chatEvents)
    .leftJoin(
      chatEventInputParams,
      eq(chatEventInputParams.eventId, chatEvents.id),
    )
    .leftJoin(
      threadGoals,
      and(
        eq(threadGoals.id, args.goalId),
        eq(threadGoals.chatThreadId, chatEvents.chatThreadId),
        eq(threadGoals.orgId, args.orgId),
        eq(threadGoals.ownerUserId, args.userId),
        eq(chatEvents.runGroupId, threadGoals.id),
      ),
    )
    .leftJoin(
      chatGoalContext,
      and(
        eq(chatEvents.contextType, "goal"),
        eq(chatGoalContext.id, chatEvents.contextId),
      ),
    )
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        pendingChatQueueEventCondition(db),
      ),
    )
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (
    !head ||
    head.eventType !== "input.goal" ||
    head.id !== args.eventId ||
    head.goalId !== args.goalId ||
    head.goalStatus !== "active" ||
    !head.goalSnapshotCurrent
  ) {
    return null;
  }
  const userMessage =
    head.userMessage ??
    (head.goalBrief
      ? createUserMessageDocument({
          text: null,
          nonContentPart: {
            type: "goal",
            goalBrief: head.goalBrief,
          },
        })
      : null);
  if (!userMessage) {
    throw new Error("Goal queue event is missing its user message");
  }
  return {
    target: replacementTargetFromQueueHead(head),
    replacement: {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage,
      runId: args.runId,
      runGroupId: args.goalId,
      triggerSource: "workflow-event",
    },
  };
}

async function resolveQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: QueueFirstClaimArgs,
): Promise<QueueFirstClaimSnapshot | null> {
  if (args.kind === "user_message") {
    return await resolveUserQueueFirstClaimSnapshot(db, args);
  }
  if (args.kind === "workflow_event") {
    return await resolveWorkflowQueueFirstClaimSnapshot(db, args);
  }
  return await resolveGoalQueueFirstClaimSnapshot(db, args);
}

function queueFirstRunAdmissionBlocked(
  db: DbTransaction,
  args: { readonly admissionTime: number; readonly threadId: string },
): Promise<boolean> {
  return chatThreadAdmissionBlocked(db, {
    threadId: args.threadId,
    apiStartTime: args.admissionTime,
  });
}

/**
 * Resolve the transaction-scoped thread admission consumed by queue claim.
 * Successful launches hold the organization admission lock; failed launches
 * preserve their existing thread-only arbitration.
 */
export async function resolveQueueFirstRunAdmission(
  db: DbTransaction,
  args: {
    readonly admissionTime: number;
    readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
    readonly threadAlreadyLocked?: true;
    readonly threadId: string;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<QueueFirstRunAdmission> {
  let outcome: QueueFirstRunAdmission["kind"] | undefined;
  return await args.timing.measure(
    "api_dispatch_resolve_queue_first_admission",
    "nested",
    async () => {
      const threadExists =
        args.threadAlreadyLocked ??
        (await args.timing.measure(
          "api_dispatch_queue_first_thread_lock_wait",
          "nested",
          async () => {
            return await lockUserMessageQueueThread(db, args.threadId);
          },
        ));
      if (!threadExists) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      if (await queueFirstRunAdmissionBlocked(db, args)) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      outcome = "idle";
      return { kind: "idle" };
    },
    () => {
      return {
        ...(outcome ? { queue_first_admission_result: outcome } : {}),
        thread_session_snapshot_state: args.sessionSnapshotState,
      };
    },
  );
}

export async function claimQueueFirstRunAssociation(
  db: DbTransaction,
  args: QueueFirstClaimArgs,
): Promise<QueueFirstRunClaimResult> {
  let outcome: "claimed" | "lost" | "error" = "error";
  const claimDimensions = {
    queue_first_association_kind: args.kind,
  };
  return await args.timing.measure(
    "api_dispatch_claim_queue_first_message",
    "nested",
    async () => {
      if (args.admission.kind === "blocked") {
        outcome = "lost";
        return { kind: "lost" };
      }

      const snapshot = await args.timing.measure(
        "api_dispatch_resolve_queue_first_claim_snapshot",
        "nested",
        async () => {
          return await resolveQueueFirstClaimSnapshot(db, args);
        },
        claimDimensions,
      );
      if (!snapshot) {
        outcome = "lost";
        return { kind: "lost" };
      }

      if (
        args.kind === "user_message" &&
        !(await lockUnclaimedMorningBriefDelivery(
          db,
          args.morningBriefDeliveryId,
        ))
      ) {
        outcome = "lost";
        return { kind: "lost" };
      }

      const claimed = await args.timing.measure(
        "api_dispatch_persist_queue_first_replacement",
        "nested",
        async () => {
          return await replaceLoadedChatEvent(
            db,
            snapshot.target,
            snapshot.replacement,
          );
        },
        claimDimensions,
      );
      if (!claimed) {
        if (args.kind !== "user_message") {
          throw new Error(`Claimed ${args.kind} queue event disappeared`);
        }
        outcome = "lost";
        return { kind: "lost" };
      }
      if (
        args.kind === "user_message" &&
        "triggerSource" in snapshot.replacement &&
        snapshot.replacement.triggerSource === "web" &&
        args.attachFileMetadata
      ) {
        await attachCanonicalWebInputAssetsToEvent(db, {
          eventId: claimed.id,
          chatThreadId: args.threadId,
          userId: args.userId,
          orgId: args.orgId,
          files: args.attachFileMetadata,
        });
      }

      outcome = "claimed";
      return {
        kind: "claimed",
        createdAt: claimed.createdAt,
        ...(args.kind === "user_message" && args.morningBriefDeliveryId
          ? { morningBriefDeliveryId: args.morningBriefDeliveryId }
          : {}),
      };
    },
    () => {
      return { queue_first_claim_result: outcome };
    },
  );
}

async function lockUnclaimedMorningBriefDelivery(
  db: DbTransaction,
  deliveryId: string | undefined,
): Promise<boolean> {
  if (!deliveryId) {
    return true;
  }
  const [delivery] = await db
    .select({ runId: morningBriefDeliveries.runId })
    .from(morningBriefDeliveries)
    .where(eq(morningBriefDeliveries.id, deliveryId))
    .for("update")
    .limit(1);
  return delivery?.runId === null;
}

/**
 * Finish queue-claim side effects that reference the newly inserted run row.
 * The caller invokes this in the same final-admission transaction immediately
 * after run persistence so the delivery foreign key and queue claim commit
 * atomically.
 */
export async function recordQueueFirstClaimedRun(
  db: DbTransaction,
  args: {
    readonly claim: Extract<
      QueueFirstRunClaimResult,
      { readonly kind: "claimed" }
    >;
    readonly runId: string;
  },
): Promise<void> {
  if (!args.claim.morningBriefDeliveryId) {
    return;
  }
  const [delivery] = await db
    .update(morningBriefDeliveries)
    .set({
      status: "running",
      runId: args.runId,
      updatedAt: sql`now()`,
    })
    .where(eq(morningBriefDeliveries.id, args.claim.morningBriefDeliveryId))
    .returning({ id: morningBriefDeliveries.id });
  if (!delivery) {
    throw new Error("Failed to record the admitted morning brief run");
  }
}

/**
 * A failed queue-first launch still owns the queue claim and run foreign key,
 * but must never make the Morning Brief delivery look active.
 */
export async function recordQueueFirstFailedRun(
  db: DbTransaction,
  args: {
    readonly claim: Extract<
      QueueFirstRunClaimResult,
      { readonly kind: "claimed" }
    >;
    readonly runId: string;
  },
): Promise<void> {
  if (!args.claim.morningBriefDeliveryId) {
    return;
  }
  const [delivery] = await db
    .update(morningBriefDeliveries)
    .set({
      status: "failed",
      runId: args.runId,
      updatedAt: sql`now()`,
    })
    .where(eq(morningBriefDeliveries.id, args.claim.morningBriefDeliveryId))
    .returning({ id: morningBriefDeliveries.id });
  if (!delivery) {
    throw new Error("Failed to record the failed morning brief run");
  }
}

/**
 * Discard a queue-first user message that never dispatched by appending a
 * tombstone. The revoke edge removes it from both queue and visible history.
 */
export async function discardUnclaimedUserMessageInTransaction(
  db: DbTransaction,
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  if (!(await lockUserMessageQueueThread(db, args.threadId))) {
    return false;
  }
  const pending = await loadPendingChatQueueEvent(db, {
    chatThreadId: args.threadId,
    eventId: args.eventId,
  });
  if (pending?.eventType !== "input.prompt") {
    return false;
  }
  const tombstone = await revokeChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "control.revoke",
    runId: null,
  });
  if (!tombstone) {
    throw new Error("Failed to append discarded user message tombstone");
  }
  return true;
}

export async function discardUnclaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await discardUnclaimedUserMessageInTransaction(tx, args);
  });
}

/**
 * Consume the current queue head without a run and append canonical user and
 * assistant replacements that explain a permanent integration admission
 * failure.
 */
export async function failQueuedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly eventId: string;
    readonly assistantContent: string;
    readonly errorMarker: string;
    readonly currentTime: Date;
  },
): Promise<{ readonly assistantEventId: string } | null> {
  return await db.transaction(async (tx) => {
    if (!(await lockUserMessageQueueThread(tx, args.threadId))) {
      return null;
    }
    if (
      (await loadNextUnclaimedQueuedUserMessageId(tx, args.threadId)) !==
      args.eventId
    ) {
      return null;
    }

    const [queued] = await tx
      .select({
        userMessage: chatEvents.userMessage,
        attachFiles: chatEvents.attachFiles,
        generationTemplate: chatEvents.generationTemplate,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.threadId),
          chatEventTypeIn(["input.prompt"]),
          isNull(chatEvents.runId),
        ),
      )
      .for("update", { of: chatEvents })
      .limit(1);
    if (!queued) {
      return null;
    }
    if (!queued.userMessage) {
      throw new Error("Queued input event is missing userMessage");
    }

    const replacement = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.threadId,
      eventType: "input.rejected",
      userMessage: queued.userMessage,
      attachFiles: queued.attachFiles ? [...queued.attachFiles] : null,
      generationTemplate: queued.generationTemplate,
      runId: null,
      error: args.errorMarker,
      createdAt: args.currentTime,
    });
    if (!replacement) {
      return null;
    }

    const assistant = await insertChatEvent(tx, {
      chatThreadId: args.threadId,
      eventType: "output.error",
      content: args.assistantContent,
      runId: null,
      error: args.errorMarker,
      createdAt: new Date(args.currentTime.getTime() + 1),
    });
    if (!assistant) {
      throw new Error("Failed to append integration admission error");
    }
    await touchChatThreadLastMessageAt(tx, args.threadId, assistant.createdAt);
    return { assistantEventId: assistant.id };
  });
}
