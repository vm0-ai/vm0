import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { feishuChatThreadRoutes } from "@vm0/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, countDistinct, eq, isNotNull } from "drizzle-orm";

import { buildFeishuAgentResponseMessage } from "../../lib/feishu-message-card";
import { logger } from "../../lib/log";
import {
  removeFeishuMessageReaction,
  replyWithFeishuMessage,
  sendFeishuMessage,
} from "../external/feishu-client";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import { settleIncludingAbort } from "../utils";
import {
  feishuChatCallbackPayloadSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

const L = logger("InternalCallbacksFeishuChat");

async function markDelivered(db: Db, callbackId: string): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "delivered", deliveredAt: nowDate() })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "failed", lastError: error.slice(0, 4000) })
    .where(eq(agentRunCallbacks.id, callbackId));
}

function recordDelivery(args: {
  readonly runId: string;
  readonly startedAt: number;
  readonly success: boolean;
  readonly outcome: "delivered" | "failed" | "skipped_revoked";
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "feishu_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

interface ClaimedFeishuChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

async function claimFeishuChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedFeishuChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "feishu:chat"),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRunCallbacks.attempts, 0),
      ),
    )
    .returning({
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

async function loadFeishuChatDeliveryContext(args: {
  readonly db: Db;
  readonly callback: ClaimedFeishuChatDelivery;
  readonly signal: AbortSignal;
}) {
  const payload = feishuChatCallbackPayloadSchema.parse(args.callback.payload);
  const [run] = await args.db
    .select({
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      chatThreadId: zeroRuns.chatThreadId,
      agentId: chatThreads.agentComposeId,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, args.callback.runId),
        eq(zeroRuns.triggerSource, "feishu"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("Feishu chat delivery run context is unavailable");
  }

  const [event] = await args.db
    .select({ content: chatEvents.content })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, payload.chatEventId),
        eq(chatEvents.runId, args.callback.runId),
        eq(chatEvents.chatThreadId, run.chatThreadId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
        isNotNull(chatEvents.content),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!event?.content) {
    throw new Error("Feishu chat delivery message is unavailable");
  }

  const [binding] = await args.db
    .select({
      feishuOpenId: feishuOrgConnections.feishuOpenId,
      defaultAgentId: feishuOrgInstallations.defaultComposeId,
    })
    .from(feishuChatThreadRoutes)
    .innerJoin(
      feishuOrgConnections,
      eq(feishuOrgConnections.id, feishuChatThreadRoutes.connectionId),
    )
    .innerJoin(
      feishuOrgInstallations,
      eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
    )
    .where(
      and(
        eq(feishuChatThreadRoutes.chatThreadId, run.chatThreadId),
        eq(feishuChatThreadRoutes.chatId, payload.chatId),
        eq(feishuChatThreadRoutes.threadId, payload.threadId),
        eq(feishuChatThreadRoutes.userId, run.userId),
        eq(feishuChatThreadRoutes.connectionId, payload.connectionId),
        eq(feishuOrgConnections.vm0UserId, run.userId),
        eq(feishuOrgInstallations.id, payload.installationId),
        eq(feishuOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return { payload, run, messageContent: event.content, binding };
}

async function countFeishuMentioners(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly chatId: string;
  readonly threadId: string;
}): Promise<number> {
  const [row] = await args.db
    .select({ count: countDistinct(feishuChatThreadRoutes.connectionId) })
    .from(feishuChatThreadRoutes)
    .innerJoin(
      feishuOrgConnections,
      eq(feishuOrgConnections.id, feishuChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(feishuOrgConnections.installationId, args.installationId),
        eq(feishuChatThreadRoutes.chatId, args.chatId),
        eq(feishuChatThreadRoutes.threadId, args.threadId),
      ),
    );
  return row?.count ?? 0;
}

async function deliverClaimedFeishuChatCallback(args: {
  readonly db: Db;
  readonly callback: ClaimedFeishuChatDelivery;
  readonly signal: AbortSignal;
}): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadFeishuChatDeliveryContext(args);
  if (!binding) {
    return "skipped_revoked";
  }

  const [mentionerCount, featureContext] = await Promise.all([
    countFeishuMentioners({
      db: args.db,
      installationId: payload.installationId,
      chatId: payload.chatId,
      threadId: payload.threadId,
    }),
    loadUserFeatureSwitchContext(args.db, run.orgId, run.userId),
  ]);
  args.signal.throwIfAborted();
  const presentation = await resolveIntegrationAgentResponsePresentation({
    db: args.db,
    orgId: run.orgId,
    userId: run.userId,
    runId: args.callback.runId,
    agentId: run.agentId,
    defaultAgentId: binding.defaultAgentId,
    replyToMention:
      payload.replyInThread && mentionerCount > 1
        ? `<at id=${binding.feishuOpenId}></at>`
        : undefined,
    getFeatureOverrides: () => {
      return Promise.resolve(featureContext.overrides ?? {});
    },
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  const message = buildFeishuAgentResponseMessage({
    text: messageContent,
    auditUrl: presentation.logsUrl,
    footerText: presentation.footerText,
  });
  if (payload.replyInThread) {
    await replyWithFeishuMessage({
      db: args.db,
      installationId: payload.installationId,
      messageId: payload.messageId,
      message,
      replyInThread: true,
      signal: args.signal,
    });
  } else {
    await sendFeishuMessage({
      db: args.db,
      installationId: payload.installationId,
      receiveIdType: "chat_id",
      receiveId: payload.chatId,
      message,
      idempotencyKey: args.callback.runId,
      signal: args.signal,
    });
  }
  return "delivered";
}

export async function clearCanonicalFeishuThinkingReaction(
  db: Db,
  target: FeishuDeliveryTarget,
  signal: AbortSignal,
): Promise<void> {
  if (!target.reactionId) {
    return;
  }
  await removeFeishuMessageReaction({
    db,
    installationId: target.installationId,
    messageId: target.messageId,
    reactionId: target.reactionId,
    signal,
  });
}

export async function dispatchFeishuChatDeliveryOnce(
  db: Db,
  callbackId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimFeishuChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedFeishuChatCallback({
      db,
      callback,
      signal,
    }),
  );
  if (!delivery.ok) {
    const message =
      delivery.error instanceof Error
        ? delivery.error.message
        : "Unknown error";
    await markFailed(db, callbackId, message);
    recordDelivery({
      runId: callback.runId,
      startedAt,
      success: false,
      outcome: "failed",
    });
    L.warn("Canonical Feishu delivery failed", {
      callbackId,
      runId: callback.runId,
      error: delivery.error,
    });
    return;
  }

  await markDelivered(db, callbackId);
  recordDelivery({
    runId: callback.runId,
    startedAt,
    success: true,
    outcome: delivery.value,
  });
  if (delivery.value === "skipped_revoked") {
    L.debug("Skipped canonical Feishu delivery after binding revocation", {
      callbackId,
      runId: callback.runId,
    });
  }
}
