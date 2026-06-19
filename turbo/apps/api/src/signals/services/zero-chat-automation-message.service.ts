import {
  chatMessages,
  type ChatMessageAutomationSnapshot,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import { badRequestMessage, providerDeleted } from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { nowDate } from "../external/time";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";
import {
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ModelFirstPin,
  modelOnlyModelFirstPin,
  modelProviderPinAvailable,
  resolveDefaultModelFirstPin,
  resolveModelSelectionPin,
} from "./zero-model-selection.service";

type AutomationChatThreadModelPin = ModelFirstPin;

type AutomationChatThreadModelPinResult =
  | AutomationChatThreadModelPin
  | ReturnType<typeof providerDeleted>
  | ReturnType<typeof badRequestMessage>;

async function getStoredThreadModelPin(
  db: Db,
  threadId: string,
): Promise<AutomationChatThreadModelPin | null> {
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
): Promise<AutomationChatThreadModelPin | null> {
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
): Promise<AutomationChatThreadModelPin | null> {
  return (
    (await getStoredThreadModelPin(db, threadId)) ??
    (await getFirstRunModelPin(db, threadId))
  );
}

async function resolveStoredModelFirstPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly pin: AutomationChatThreadModelPin;
}): Promise<AutomationChatThreadModelPinResult> {
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
 * Resolve the model pin for a chat-mode automation run from its linked thread:
 * the thread's stored pin, else its first-run pin, else the org default.
 */
export async function resolveAutomationChatThreadModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<AutomationChatThreadModelPinResult> {
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
 * Post an automation run's prompt as a user chat message into its linked
 * thread and publish realtime signals so the client surfaces the run.
 */
export async function postAutomationUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly appendQueueMarker: boolean;
  readonly automationTitle?: string;
  readonly automationSnapshot?: ChatMessageAutomationSnapshot;
}): Promise<void> {
  await params.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(chatMessages)
      .values({
        chatThreadId: params.threadId,
        role: "user",
        content: params.prompt,
        runId: params.runId,
        automationTitle: params.automationTitle,
        automationSnapshot: params.automationSnapshot,
      })
      .returning({ createdAt: chatMessages.createdAt });
    if (params.appendQueueMarker) {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        createdAfter: inserted?.createdAt ?? nowDate(),
      });
    }
  });
  await publishUserSignal(
    [params.userId],
    `chatThreadMessageCreated:${params.threadId}`,
  );
  await publishUserSignal(
    [params.userId],
    `chatThreadRunCreated:${params.threadId}`,
  );
  await publishThreadListChanged(params.userId);
}
