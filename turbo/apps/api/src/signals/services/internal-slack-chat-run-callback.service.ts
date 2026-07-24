import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, countDistinct, eq, isNotNull } from "drizzle-orm";

import { buildAgentResponseMessage } from "../../lib/slack-blocks";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  createSlackClient,
  postMessage,
} from "../external/slack-message-client";
import { now, nowDate } from "../external/time";
import { settleIncludingAbort } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveIntegrationAgentResponsePresentation } from "./integration-agent-response-presentation.service";
import { slackChatCallbackPayloadSchema } from "./slack-chat-callback-payload";

const L = logger("InternalCallbacksSlackChat");

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
    actionType: "slack_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

interface ClaimedSlackChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

async function claimSlackChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedSlackChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "slack:chat"),
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

async function loadSlackChatDeliveryContext(args: {
  readonly db: Db;
  readonly callback: ClaimedSlackChatDelivery;
  readonly signal: AbortSignal;
}) {
  const payload = slackChatCallbackPayloadSchema.parse(args.callback.payload);
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
        eq(zeroRuns.triggerSource, "slack"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!run?.chatThreadId) {
    throw new Error("Slack chat delivery run context is unavailable");
  }

  const [message] = await args.db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.id, payload.chatMessageId),
        eq(chatMessages.runId, args.callback.runId),
        eq(chatMessages.chatThreadId, run.chatThreadId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
        isNotNull(chatMessages.content),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  const messageContent = message?.content;
  if (!messageContent) {
    throw new Error("Slack chat delivery message is unavailable");
  }

  const [binding] = await args.db
    .select({
      slackUserId: slackOrgConnections.slackUserId,
      workspaceId: slackOrgConnections.slackWorkspaceId,
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
    })
    .from(slackChatThreadRoutes)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
    )
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgInstallations.slackWorkspaceId,
        slackOrgConnections.slackWorkspaceId,
      ),
    )
    .where(
      and(
        eq(slackChatThreadRoutes.chatThreadId, run.chatThreadId),
        eq(slackChatThreadRoutes.channelId, payload.channelId),
        eq(slackChatThreadRoutes.threadTs, payload.threadTs),
        eq(slackChatThreadRoutes.userId, run.userId),
        eq(slackChatThreadRoutes.backend, "canonical"),
        eq(slackOrgConnections.vm0UserId, run.userId),
        eq(slackOrgInstallations.orgId, run.orgId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return { payload, run, messageContent, binding };
}

async function countCanonicalSlackMentioners(args: {
  readonly db: Db;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
}): Promise<number> {
  const [row] = await args.db
    .select({ count: countDistinct(slackChatThreadRoutes.connectionId) })
    .from(slackChatThreadRoutes)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        eq(slackChatThreadRoutes.channelId, args.channelId),
        eq(slackChatThreadRoutes.threadTs, args.threadTs),
        eq(slackChatThreadRoutes.backend, "canonical"),
      ),
    );
  return row?.count ?? 0;
}

async function deliverClaimedSlackChatCallback(args: {
  readonly db: Db;
  readonly callback: ClaimedSlackChatDelivery;
  readonly signal: AbortSignal;
}): Promise<"delivered" | "skipped_revoked"> {
  const { payload, run, messageContent, binding } =
    await loadSlackChatDeliveryContext(args);
  if (!binding) {
    return "skipped_revoked";
  }

  const [mentionerCount, featureContext] = await Promise.all([
    countCanonicalSlackMentioners({
      db: args.db,
      workspaceId: binding.workspaceId,
      channelId: payload.channelId,
      threadTs: payload.threadTs,
    }),
    loadUserFeatureSwitchContext(args.db, run.orgId, run.userId),
  ]);
  args.signal.throwIfAborted();
  const [botToken, presentation] = await Promise.all([
    decryptPersistentSecretValue(binding.encryptedBotToken, featureContext),
    resolveIntegrationAgentResponsePresentation({
      db: args.db,
      orgId: run.orgId,
      userId: run.userId,
      runId: args.callback.runId,
      agentId: run.agentId,
      replyToMention:
        mentionerCount > 1 ? `<@${binding.slackUserId}>` : undefined,
      getFeatureOverrides: () => {
        return Promise.resolve(featureContext.overrides ?? {});
      },
      signal: args.signal,
    }),
  ]);
  args.signal.throwIfAborted();

  const postResult = await postMessage(
    createSlackClient(botToken),
    payload.channelId,
    messageContent,
    {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(
        messageContent,
        presentation.logsUrl,
        presentation.footerText,
      ),
    },
  );
  if (postResult.kind === "slack_error") {
    throw new Error(`Slack API error: ${postResult.error}`);
  }
  return "delivered";
}

export async function dispatchSlackChatDeliveryOnce(
  db: Db,
  callbackId: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimSlackChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }

  const delivery = await settleIncludingAbort(
    deliverClaimedSlackChatCallback({
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
    L.warn("Canonical Slack delivery failed", {
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
    L.debug("Skipped canonical Slack delivery after binding revocation", {
      callbackId,
      runId: callback.runId,
    });
  }
}
