import { chatMessages } from "@vm0/db/schema/chat-message";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { and, asc, eq, isNotNull } from "drizzle-orm";

import { badRequestMessage } from "../../lib/error";
import type { Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";
import {
  resolvePersistedChatThreadModel,
  type ResolvedPersistedChatThreadModel,
} from "./zero-chat-thread-model.service";

async function getFirstRunSelectedModel(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const [run] = await db
    .select({ selectedModel: zeroRuns.selectedModel })
    .from(chatMessages)
    .innerJoin(zeroRuns, eq(zeroRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        chatEventTypeIn(["input.prompt"]),
        isNotNull(chatMessages.runId),
        isNotNull(zeroRuns.selectedModel),
      ),
    )
    .orderBy(asc(chatMessages.seqId))
    .limit(1);
  return run?.selectedModel ?? null;
}

/**
 * Resolve a chat-derived run against the current workspace model policy.
 * Legacy threads without a stored model may use their first run as the sticky
 * preference before normal workspace-default recovery applies.
 */
export async function resolveRunChatThreadModelContext(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
}): Promise<
  ResolvedPersistedChatThreadModel | ReturnType<typeof badRequestMessage>
> {
  const [fallbackSelectedModel, featureSwitchContext] = await Promise.all([
    getFirstRunSelectedModel(params.db, params.threadId),
    loadUserFeatureSwitchContext(params.db, params.orgId, params.userId),
  ]);
  const resolved = await resolvePersistedChatThreadModel({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    threadId: params.threadId,
    fallbackSelectedModel,
    persistRequestedCodexServiceTier: false,
    codexFastModeEnabled: isFeatureEnabled(
      FeatureSwitchKey.CodexFastMode,
      featureSwitchContext,
    ),
  });
  if (!resolved) {
    return badRequestMessage("Chat thread not found");
  }
  return resolved;
}

async function publishRunUserMessageSignals(
  userId: string,
  threadId: string,
): Promise<void> {
  await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
  await publishThreadListChanged(userId);
}

/**
 * Finish the side effects for a user message inserted by a queue-first run
 * claim. The claim and run rows already committed atomically; only a queued
 * marker and realtime notifications remain.
 */
export async function finalizeClaimedRunUserMessage(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly runId: string;
  readonly runStatus: string;
  readonly runGroupId?: string;
  readonly createdAt: Date;
}): Promise<void> {
  if (params.runStatus === "queued") {
    await params.db.transaction(async (tx): Promise<void> => {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: params.threadId,
        runId: params.runId,
        runGroupId: params.runGroupId,
        createdAfter: params.createdAt,
      });
    });
  }
  await publishRunUserMessageSignals(params.userId, params.threadId);
}
