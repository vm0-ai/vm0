import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessageQueue } from "@vm0/db/schema/chat-message-queue";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { slackChatIngress } from "@vm0/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../external/db";
import {
  createSlackClient,
  setThreadStatus,
} from "../external/slack-message-client";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";

const ACTIVE_RUN_STATUSES = ["queued", "pending", "running"] as const;
const ACTIVE_INGRESS_STATUSES = ["pending", "processing"] as const;

const slackStatusIngressPayloadSchema = z.object({
  event: z.object({
    ts: z.string(),
    thread_ts: z.string().optional(),
  }),
});

export interface CanonicalSlackThreadStatusTarget {
  readonly chatThreadId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly routeThreadTs?: string;
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
        eq(
          slackChatThreadRoutes.threadTs,
          target.routeThreadTs ?? target.threadTs,
        ),
        eq(slackOrgConnections.vm0UserId, slackChatThreadRoutes.userId),
      ),
    )
    .limit(1);
  if (!binding?.orgId) {
    return undefined;
  }
  return { ...binding, orgId: binding.orgId };
}

async function canonicalSlackThreadHasOutstandingWorkInSnapshot(
  db: Pick<Db, "select">,
  target: CanonicalSlackThreadStatusTarget,
  workspaceId: string,
): Promise<boolean> {
  const routeThreadTs = target.routeThreadTs ?? target.threadTs;
  const spansPhysicalThreads = routeThreadTs !== target.threadTs;
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
        eq(slackChatThreadRoutes.threadTs, routeThreadTs),
      ),
    );
  const routeIds = routes.map((route) => {
    return route.id;
  });
  const chatThreadIds = routes.map((route) => {
    return route.chatThreadId;
  });
  if (routeIds.length === 0 || chatThreadIds.length === 0) {
    return false;
  }

  const activeIngress = await db
    .select({ payload: slackChatIngress.payload })
    .from(slackChatIngress)
    .where(
      and(
        inArray(slackChatIngress.routeId, routeIds),
        inArray(slackChatIngress.status, ACTIVE_INGRESS_STATUSES),
      ),
    );
  if (
    activeIngress.some((ingress) => {
      return (
        !spansPhysicalThreads ||
        slackPhysicalThreadTs(ingress.payload) === target.threadTs
      );
    })
  ) {
    return true;
  }
  const queuedSlackMessages = await db
    .select({ payload: slackChatIngress.payload })
    .from(chatMessageQueue)
    .innerJoin(
      slackChatIngress,
      eq(slackChatIngress.id, chatMessageQueue.chatMessageId),
    )
    .where(
      and(
        inArray(chatMessageQueue.chatThreadId, chatThreadIds),
        eq(chatMessageQueue.itemType, "slack_user_message"),
      ),
    );
  // Dequeue atomically replaces this row with an active run, so the row
  // itself keeps the physical Slack thread busy during that handoff.
  if (
    queuedSlackMessages.some((message) => {
      return (
        !spansPhysicalThreads ||
        slackPhysicalThreadTs(message.payload) === target.threadTs
      );
    })
  ) {
    return true;
  }
  const activeRuns = await db
    .select({ payload: slackChatIngress.payload })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(
      chatMessages,
      and(
        eq(chatMessages.runId, zeroRuns.id),
        chatEventTypeIn(["input.prompt"]),
      ),
    )
    .innerJoin(
      slackChatIngress,
      eq(slackChatIngress.id, chatMessages.revokesEventId),
    )
    .where(
      and(
        inArray(zeroRuns.chatThreadId, chatThreadIds),
        inArray(agentRuns.status, ACTIVE_RUN_STATUSES),
        eq(zeroRuns.triggerSource, "slack"),
      ),
    );
  return activeRuns.some((run) => {
    return (
      !spansPhysicalThreads ||
      slackPhysicalThreadTs(run.payload) === target.threadTs
    );
  });
}

function slackPhysicalThreadTs(payload: string): string {
  const parsed = slackStatusIngressPayloadSchema.parse(
    JSON.parse(payload) as unknown,
  );
  return parsed.event.thread_ts ?? parsed.event.ts;
}

async function canonicalSlackThreadHasOutstandingWork(
  db: Db,
  target: CanonicalSlackThreadStatusTarget,
  workspaceId: string,
): Promise<boolean> {
  // The ingress-to-queue and queue-to-run handoffs are transactional. Read
  // one snapshot so the status cannot combine opposite sides of a commit
  // into an idle state that never actually existed.
  return await db.transaction(
    async (tx) => {
      return await canonicalSlackThreadHasOutstandingWorkInSnapshot(
        tx,
        target,
        workspaceId,
      );
    },
    { isolationLevel: "repeatable read" },
  );
}

export async function canonicalSlackThreadStatusTargetForIngress(
  db: Db,
  ingressId: string,
): Promise<CanonicalSlackThreadStatusTarget | undefined> {
  const [target] = await db
    .select({
      chatThreadId: slackChatThreadRoutes.chatThreadId,
      channelId: slackChatThreadRoutes.channelId,
      routeThreadTs: slackChatThreadRoutes.threadTs,
      payload: slackChatIngress.payload,
    })
    .from(slackChatIngress)
    .innerJoin(
      slackChatThreadRoutes,
      eq(slackChatThreadRoutes.id, slackChatIngress.routeId),
    )
    .where(eq(slackChatIngress.id, ingressId))
    .limit(1);
  if (!target) {
    return undefined;
  }
  const threadTs = slackPhysicalThreadTs(target.payload);
  return {
    chatThreadId: target.chatThreadId,
    channelId: target.channelId,
    threadTs,
    ...(threadTs === target.routeThreadTs
      ? {}
      : { routeThreadTs: target.routeThreadTs }),
  };
}

export async function refreshCanonicalSlackThreadStatus(
  db: Db,
  target: CanonicalSlackThreadStatusTarget,
  signal: AbortSignal,
): Promise<boolean> {
  const binding = await loadCanonicalSlackThreadStatusBinding(db, target);
  signal.throwIfAborted();
  if (!binding) {
    return false;
  }
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
    "is thinking...",
  );
  signal.throwIfAborted();
  return true;
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
  const client = createSlackClient(botToken);
  let appliedStatus = "";
  while (true) {
    await setThreadStatus(
      client,
      target.channelId,
      target.threadTs,
      appliedStatus,
    );
    signal.throwIfAborted();

    // Work can start while a Slack status request is in flight. Reconcile
    // until the persisted lifecycle agrees with the last status we applied;
    // later lifecycle transitions schedule their own reconciliation.
    const desiredStatus = (await canonicalSlackThreadHasOutstandingWork(
      db,
      target,
      binding.workspaceId,
    ))
      ? "is thinking..."
      : "";
    signal.throwIfAborted();
    if (desiredStatus === appliedStatus) {
      return appliedStatus === "";
    }
    appliedStatus = desiredStatus;
  }
}
