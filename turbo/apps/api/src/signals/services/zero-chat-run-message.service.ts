import {
  chatMessages,
  type ChatMessageGoalSnapshot,
} from "@vm0/db/schema/chat-message";
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
import { nowDate } from "../external/time";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { insertChatMessage } from "./zero-chat-message.service";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";
import { nonEmptyGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";
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
        eq(chatMessages.role, "user"),
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
  await params.db.transaction(async (tx): Promise<void> => {
    const inserted = await insertChatMessage(tx, {
      chatThreadId: params.threadId,
      role: "user",
      content: params.prompt,
      runId: params.runId,
      runGroupId: params.runGroupId,
      goalSnapshot,
    });
    if (!params.appendQueueMarker) {
      return;
    }
    await appendQueuedRunAssistantMarker(tx, {
      chatThreadId: params.threadId,
      runId: params.runId,
      runGroupId: params.runGroupId,
      createdAfter: inserted?.createdAt ?? nowDate(),
    });
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
