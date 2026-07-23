import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { slackChatIngress } from "@vm0/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  createSlackClient,
  setThreadStatus,
} from "../external/slack-message-client";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const ACTIVE_INGRESS_STATUSES = ["pending", "processing"] as const;

export interface CanonicalSlackThreadStatusTarget {
  readonly chatThreadId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

interface CanonicalSlackThreadStatusBinding {
  readonly encryptedBotToken: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

async function loadCanonicalSlackThreadStatusBinding(
  db: Db,
  target: CanonicalSlackThreadStatusTarget,
): Promise<CanonicalSlackThreadStatusBinding | undefined> {
  const [binding] = await db
    .select({
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
      orgId: slackOrgInstallations.orgId,
      userId: slackChatThreadRoutes.userId,
      workspaceId: slackOrgConnections.slackWorkspaceId,
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
        eq(slackChatThreadRoutes.chatThreadId, target.chatThreadId),
        eq(slackChatThreadRoutes.channelId, target.channelId),
        eq(slackChatThreadRoutes.threadTs, target.threadTs),
        eq(slackChatThreadRoutes.backend, "canonical"),
        eq(slackOrgConnections.vm0UserId, slackChatThreadRoutes.userId),
      ),
    )
    .limit(1);
  if (!binding?.orgId) {
    return undefined;
  }
  return { ...binding, orgId: binding.orgId };
}

async function canonicalSlackThreadHasOutstandingWork(
  db: Db,
  target: CanonicalSlackThreadStatusTarget,
  workspaceId: string,
): Promise<boolean> {
  const routes = await db
    .select({
      id: slackChatThreadRoutes.id,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
    })
    .from(slackChatThreadRoutes)
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
    )
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
        eq(slackChatThreadRoutes.channelId, target.channelId),
        eq(slackChatThreadRoutes.threadTs, target.threadTs),
        eq(slackChatThreadRoutes.backend, "canonical"),
        isNotNull(slackChatThreadRoutes.chatThreadId),
      ),
    );
  const routeIds = routes.map((route) => {
    return route.id;
  });
  const chatThreadIds = routes.flatMap((route) => {
    return route.chatThreadId ? [route.chatThreadId] : [];
  });
  if (routeIds.length === 0 || chatThreadIds.length === 0) {
    return false;
  }

  const [activeIngress, activeRuns, queuedSlackMessages] = await Promise.all([
    db
      .select({ id: slackChatIngress.id })
      .from(slackChatIngress)
      .where(
        and(
          inArray(slackChatIngress.routeId, routeIds),
          inArray(slackChatIngress.status, ACTIVE_INGRESS_STATUSES),
        ),
      )
      .limit(1),
    db
      .select({
        chatThreadId: zeroRuns.chatThreadId,
        triggerSource: zeroRuns.triggerSource,
      })
      .from(zeroRuns)
      .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
      .where(
        and(
          inArray(zeroRuns.chatThreadId, chatThreadIds),
          inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
        ),
      ),
    db
      .select({ chatThreadId: chatMessageQueue.chatThreadId })
      .from(chatMessageQueue)
      .where(
        and(
          inArray(chatMessageQueue.chatThreadId, chatThreadIds),
          eq(chatMessageQueue.itemType, "slack_user_message"),
        ),
      ),
  ]);
  if (activeIngress.length > 0) {
    return true;
  }
  if (
    activeRuns.some((run) => {
      return run.triggerSource === "slack";
    })
  ) {
    return true;
  }

  const activeChatThreadIds = new Set(
    activeRuns.flatMap((run) => {
      return run.chatThreadId ? [run.chatThreadId] : [];
    }),
  );
  return queuedSlackMessages.some((message) => {
    return activeChatThreadIds.has(message.chatThreadId);
  });
}

export async function canonicalSlackThreadStatusTargetForIngress(
  db: Db,
  ingressId: string,
): Promise<CanonicalSlackThreadStatusTarget | undefined> {
  const [target] = await db
    .select({
      chatThreadId: slackChatThreadRoutes.chatThreadId,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
    })
    .from(slackChatIngress)
    .innerJoin(
      slackChatThreadRoutes,
      eq(slackChatThreadRoutes.id, slackChatIngress.routeId),
    )
    .where(
      and(
        eq(slackChatIngress.id, ingressId),
        eq(slackChatThreadRoutes.backend, "canonical"),
        isNotNull(slackChatThreadRoutes.chatThreadId),
      ),
    )
    .limit(1);
  if (!target?.chatThreadId) {
    return undefined;
  }
  return {
    chatThreadId: target.chatThreadId,
    channelId: target.channelId,
    threadTs: target.threadTs,
  };
}

export async function clearCanonicalSlackThreadStatusIfIdle(
  db: Db,
  target: CanonicalSlackThreadStatusTarget,
  signal: AbortSignal,
): Promise<boolean> {
  const binding = await loadCanonicalSlackThreadStatusBinding(db, target);
  signal.throwIfAborted();
  if (!binding) {
    return false;
  }
  if (
    await canonicalSlackThreadHasOutstandingWork(
      db,
      target,
      binding.workspaceId,
    )
  ) {
    signal.throwIfAborted();
    return false;
  }
  signal.throwIfAborted();

  const featureContext = await loadUserFeatureSwitchContext(
    db,
    binding.orgId,
    binding.userId,
  );
  signal.throwIfAborted();
  const botToken = await decryptPersistentSecretValue(
    binding.encryptedBotToken,
    featureContext,
  );
  signal.throwIfAborted();
  await setThreadStatus(
    createSlackClient(botToken),
    target.channelId,
    target.threadTs,
    "",
  );
  signal.throwIfAborted();
  return true;
}
