import {
  chatMessages,
  type ChatMessageGoalSnapshot,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import {
  badRequestMessage,
  insufficientCredits,
  providerDeleted,
} from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { nowDate } from "../external/time";
import { insertChatMessage } from "./zero-chat-message.service";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";
import { nonEmptyGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ModelFirstPin,
  modelOnlyModelFirstPin,
  modelProviderPinAvailable,
  resolveDefaultModelFirstPin,
  resolveModelSelectionPin,
} from "./zero-model-selection.service";

type RunChatThreadModelPin = ModelFirstPin;

type RunChatThreadModelPinResult =
  | RunChatThreadModelPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits>;

async function getStoredThreadModelPin(
  db: Db,
  threadId: string,
): Promise<RunChatThreadModelPin | null> {
  const [thread] = await db
    .select({ selectedModel: chatThreads.selectedModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!thread?.selectedModel) {
    return null;
  }
  return modelOnlyModelFirstPin(thread.selectedModel);
}

async function getFirstRunModelPin(
  db: Db,
  threadId: string,
): Promise<RunChatThreadModelPin | null> {
  const [run] = await db
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
  return modelOnlyModelFirstPin(run.selectedModel);
}

async function existingModelFirstThreadPin(
  db: Db,
  threadId: string,
): Promise<RunChatThreadModelPin | null> {
  return (
    (await getStoredThreadModelPin(db, threadId)) ??
    (await getFirstRunModelPin(db, threadId))
  );
}

async function resolveStoredModelFirstPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: RunChatThreadModelPin;
}): Promise<RunChatThreadModelPinResult> {
  if (!params.pin.selectedModel) {
    return params.pin;
  }
  if (params.pin.modelProviderId) {
    const available = await modelProviderPinAvailable({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      modelProviderId: params.pin.modelProviderId,
    });
    if (!available) {
      return providerDeleted();
    }
    return params.pin;
  }
  if (params.pin.modelProviderType || params.pin.modelProviderCredentialScope) {
    return params.pin;
  }
  return resolveModelSelectionPin({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    modelSelection: {
      modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
      selectedModel: params.pin.selectedModel,
    },
  });
}

/**
 * Resolve the model pin for a chat-mode run from its linked thread:
 * the thread's stored pin, else its first-run pin, else the org default.
 */
export async function resolveRunChatThreadModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<RunChatThreadModelPinResult> {
  const existing = await existingModelFirstThreadPin(
    params.db,
    params.threadId,
  );
  if (existing) {
    return resolveStoredModelFirstPin({
      db: params.db,
      orgId: params.orgId,
      userId: params.userId,
      pin: existing,
    });
  }
  return resolveDefaultModelFirstPin(params.db, params.orgId, params.userId);
}

/**
 * Post a run's prompt as a user chat message into its linked
 * thread and publish realtime signals so the client surfaces the run.
 */
export async function postRunUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly appendQueueMarker: boolean;
  readonly runGroupId?: string;
  readonly goalSnapshot?: ChatMessageGoalSnapshot;
}): Promise<void> {
  const goalSnapshot = params.goalSnapshot
    ? {
        objectiveBrief: nonEmptyGoalObjectiveBrief(
          params.goalSnapshot.objectiveBrief,
        ),
      }
    : undefined;
  await params.db.transaction(async (tx) => {
    const inserted = await insertChatMessage(tx, {
      chatThreadId: params.threadId,
      role: "user",
      content: params.prompt,
      runId: params.runId,
      runGroupId: params.runGroupId,
      goalSnapshot,
    });
    if (params.appendQueueMarker) {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        runGroupId: params.runGroupId,
        createdAfter: inserted?.createdAt ?? nowDate(),
      });
    }
  });
  await publishRunUserMessageSignals(params.userId, params.threadId);
}

/** Publish the post-commit signals for a newly materialized run user message. */
export async function publishRunUserMessageSignals(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
  await publishThreadListChanged(userId);
}
