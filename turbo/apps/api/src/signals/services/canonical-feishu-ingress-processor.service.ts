import { command } from "ccstate";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { feishuChatIngress } from "@vm0/db/schema/feishu-chat-ingress";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";

import { logger } from "../../lib/log";
import { env } from "../../lib/env";
import { buildFeishuNoticeMessage } from "../../lib/feishu-message-card";
import {
  replyWithFeishuMessage,
  sendFeishuMessage,
} from "../external/feishu-client";
import { now, nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import { feishuChatOpenUrl } from "./feishu-config";
import { ensureFeishuChatThreadRoute } from "./feishu-chat-ingress.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-message-shared.service";
import { insertChatEvent } from "./zero-chat-event.service";
import {
  encryptQueuedUserMessageRunParams,
  enqueueUserMessageQueueItem,
} from "./zero-chat-queued-message.service";
import {
  addFeishuThinkingReaction,
  buildFeishuSystemPrompt,
  dispatchConnectedFeishuCommand$,
  loadFeishuConversationHistory,
  markFeishuMessageReceived,
  replyFeishuAgentUnavailable,
  replyToUnconnectedFeishuMessage,
  resolveEffectiveFeishuAgent,
  type FeishuDispatchConnection,
  type FeishuDispatchInstallation,
  type FeishuInboundMessage,
  type FeishuPromptFile,
} from "./zero-feishu-dispatch.service";

const L = logger("CanonicalFeishuIngressProcessor");
const PROCESSING_STALE_AFTER_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 20;

const feishuPromptFileSchema = z.object({
  fileId: z.string(),
  messageId: z.string(),
  fileKey: z.string(),
  type: z.enum(["file", "image"]),
  filename: z.string(),
});

const feishuInboundMessageSchema = z.object({
  installationId: z.string(),
  eventId: z.string(),
  tenantKey: z.string(),
  appId: z.string(),
  messageId: z.string(),
  chatId: z.string(),
  chatType: z.enum(["group", "p2p", "topic_group"]),
  rootId: z.string().nullable(),
  parentId: z.string().nullable(),
  threadId: z.string().nullable(),
  openId: z.string(),
  text: z.string(),
  file: feishuPromptFileSchema.nullable(),
});

function canonicalThreadId(message: FeishuInboundMessage): string {
  return (
    message.rootId ?? message.threadId ?? message.parentId ?? message.messageId
  );
}

async function claimIngress(
  db: Db,
  ingressId: string,
  currentTime: Date,
): Promise<boolean> {
  const staleBefore = new Date(
    currentTime.getTime() - PROCESSING_STALE_AFTER_MS,
  );
  const [claimed] = await db
    .update(feishuChatIngress)
    .set({
      status: "processing",
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(feishuChatIngress.id, ingressId),
        or(
          inArray(feishuChatIngress.status, ["pending", "failed"]),
          and(
            eq(feishuChatIngress.status, "processing"),
            lt(feishuChatIngress.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({ id: feishuChatIngress.id });
  return claimed !== undefined;
}

async function loadClaimedIngress(db: Db, ingressId: string) {
  const [row] = await db
    .select({
      ingressId: feishuChatIngress.id,
      installationId: feishuChatIngress.installationId,
      payload: feishuChatIngress.payload,
      reactionId: feishuChatIngress.reactionId,
      createdAt: feishuChatIngress.createdAt,
      orgId: feishuOrgInstallations.orgId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      defaultAgentId: feishuOrgInstallations.defaultComposeId,
      messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
    })
    .from(feishuChatIngress)
    .innerJoin(
      feishuOrgInstallations,
      eq(feishuOrgInstallations.id, feishuChatIngress.installationId),
    )
    .where(
      and(
        eq(feishuChatIngress.id, ingressId),
        eq(feishuChatIngress.status, "processing"),
      ),
    )
    .limit(1);
  return row;
}

function parseMatchingMessage(
  ingress: NonNullable<Awaited<ReturnType<typeof loadClaimedIngress>>>,
): FeishuInboundMessage {
  const message = feishuInboundMessageSchema.parse(
    JSON.parse(ingress.payload) as unknown,
  );
  if (
    message.installationId !== ingress.installationId ||
    message.appId !== ingress.appId
  ) {
    throw new Error(
      "Canonical Feishu ingress payload does not match installation",
    );
  }
  return message;
}

async function loadConnection(
  db: Db,
  message: FeishuInboundMessage,
): Promise<FeishuDispatchConnection | undefined> {
  const [connection] = await db
    .select({
      id: feishuOrgConnections.id,
      vm0UserId: feishuOrgConnections.vm0UserId,
      feishuUserName: feishuOrgConnections.feishuUserName,
    })
    .from(feishuOrgConnections)
    .where(
      and(
        eq(feishuOrgConnections.installationId, message.installationId),
        eq(feishuOrgConnections.feishuOpenId, message.openId),
      ),
    )
    .limit(1);
  return connection;
}

async function markIngressProcessed(db: Db, ingressId: string): Promise<void> {
  await db
    .update(feishuChatIngress)
    .set({ status: "processed", lastError: null, updatedAt: nowDate() })
    .where(
      and(
        eq(feishuChatIngress.id, ingressId),
        eq(feishuChatIngress.status, "processing"),
      ),
    );
}

async function markIngressFailed(
  db: Db,
  ingressId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Unknown error";
  await db
    .update(feishuChatIngress)
    .set({
      status: "failed",
      lastError: message.slice(0, 4000),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(feishuChatIngress.id, ingressId),
        eq(feishuChatIngress.status, "processing"),
      ),
    );
}

interface PersistedCanonicalFeishuIngress {
  readonly userId: string;
  readonly chatThreadId: string;
  readonly message: FeishuInboundMessage;
  readonly receivedAt: Date;
}

async function persistCanonicalFeishuIngress(args: {
  readonly db: Db;
  readonly ingress: NonNullable<Awaited<ReturnType<typeof loadClaimedIngress>>>;
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
  readonly message: FeishuInboundMessage;
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly reactionId: string | undefined;
  readonly files: readonly FeishuPromptFile[];
  readonly appendSystemPrompt: string;
  readonly signal: AbortSignal;
}): Promise<PersistedCanonicalFeishuIngress> {
  const threadId = canonicalThreadId(args.message);
  const route = await ensureFeishuChatThreadRoute(args.db, {
    connectionId: args.connection.id,
    chatId: args.message.chatId,
    threadId,
    userId: args.connection.vm0UserId,
    orgId: args.installation.orgId,
    agentComposeId: args.agentId,
    selectedModel: args.selectedModel,
    currentTime: args.ingress.createdAt,
  });
  args.signal.throwIfAborted();

  const encryptedParams = await encryptQueuedUserMessageRunParams(
    {
      version: 1,
      prompt: args.message.text,
      appendSystemPrompt: args.appendSystemPrompt,
      apiStartTime: args.ingress.createdAt.getTime(),
      feishuDelivery: {
        installationId: args.message.installationId,
        connectionId: args.connection.id,
        chatId: args.message.chatId,
        messageId: args.message.messageId,
        threadId,
        replyInThread: args.message.chatType !== "p2p",
        reactionId: args.reactionId,
        files: [
          ...(args.message.file ? [args.message.file] : []),
          ...args.files,
        ].map((file) => {
          return {
            fileId: file.fileId,
            messageId: file.messageId,
            fileKey: file.fileKey,
            type: file.type,
          };
        }),
      },
      userInfoExtras: {
        feishuDisplayName: args.connection.feishuUserName ?? undefined,
        feishuOpenId: args.message.openId,
      },
    },
    {
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
    },
  );
  args.signal.throwIfAborted();

  await args.db.transaction(async (tx) => {
    const inserted = await insertChatEvent(
      tx,
      {
        id: args.ingress.ingressId,
        chatThreadId: route.chatThreadId,
        eventType: "input.prompt",
        content: args.message.text,
        runId: null,
        feishuChatOpenUrl: feishuChatOpenUrl(args.message.chatId),
        createdAt: args.ingress.createdAt,
      },
      "id",
    );
    args.signal.throwIfAborted();
    if (!inserted) {
      throw new Error("Canonical Feishu ingress message already exists");
    }
    await enqueueUserMessageQueueItem(tx, {
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
      chatThreadId: route.chatThreadId,
      chatMessageId: args.ingress.ingressId,
      triggerSource: "feishu",
      encryptedParams,
    });
    args.signal.throwIfAborted();
    await touchChatThreadLastMessageAt(
      tx,
      route.chatThreadId,
      args.ingress.createdAt,
      args.ingress.ingressId,
    );
    args.signal.throwIfAborted();
    await tx
      .update(feishuChatIngress)
      .set({ status: "processed", lastError: null, updatedAt: nowDate() })
      .where(
        and(
          eq(feishuChatIngress.id, args.ingress.ingressId),
          eq(feishuChatIngress.status, "processing"),
        ),
      );
  });
  args.signal.throwIfAborted();
  return {
    userId: args.connection.vm0UserId,
    chatThreadId: route.chatThreadId,
    message: args.message,
    receivedAt: args.ingress.createdAt,
  };
}

async function notifyQueuedFeishuRun(args: {
  readonly db: Db;
  readonly ingressId: string;
  readonly message: FeishuInboundMessage;
  readonly signal: AbortSignal;
}): Promise<void> {
  const [run] = await args.db
    .select({ status: agentRuns.status })
    .from(chatMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(
      or(
        eq(chatMessages.id, args.ingressId),
        eq(chatMessages.revokesEventId, args.ingressId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (run?.status !== "queued") {
    return;
  }
  const message = buildFeishuNoticeMessage({
    title: "Run queued",
    text: `Concurrency limit reached. Will start automatically when a slot is available.\n\n[View queue](${env("APP_URL")}/?queue=1)`,
    kind: "warning",
  });
  if (args.message.chatType === "p2p") {
    await sendFeishuMessage({
      db: args.db,
      installationId: args.message.installationId,
      receiveIdType: "chat_id",
      receiveId: args.message.chatId,
      message,
      idempotencyKey: `queued-${args.ingressId}`,
      signal: args.signal,
    });
    return;
  }
  await replyWithFeishuMessage({
    db: args.db,
    installationId: args.message.installationId,
    messageId: args.message.messageId,
    message,
    replyInThread: true,
    signal: args.signal,
  });
}

async function processClaimedIngress(args: {
  readonly db: Db;
  readonly ingressId: string;
  readonly dispatchConnectedCommand: (
    context: {
      readonly db: Db;
      readonly installation: FeishuDispatchInstallation;
      readonly connection: FeishuDispatchConnection;
      readonly message: FeishuInboundMessage;
    },
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly resolveModelRoute: (
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ) => Promise<IntegrationModelRoutePin | undefined>;
  readonly signal: AbortSignal;
}): Promise<PersistedCanonicalFeishuIngress | null> {
  const ingress = await loadClaimedIngress(args.db, args.ingressId);
  args.signal.throwIfAborted();
  if (!ingress) {
    throw new Error("Canonical Feishu ingress is unavailable");
  }
  const message = parseMatchingMessage(ingress);
  const installation: FeishuDispatchInstallation = {
    orgId: ingress.orgId,
    ownerUserId: ingress.ownerUserId,
    defaultAgentId: ingress.defaultAgentId,
    messageReceivedAt: ingress.messageReceivedAt,
  };
  await markFeishuMessageReceived({
    db: args.db,
    installation,
    message,
    signal: args.signal,
  });
  const connection = await loadConnection(args.db, message);
  args.signal.throwIfAborted();
  if (!connection) {
    await replyToUnconnectedFeishuMessage({
      db: args.db,
      message,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    await markIngressProcessed(args.db, ingress.ingressId);
    return null;
  }

  const commandHandled = await args.dispatchConnectedCommand(
    { db: args.db, installation, connection, message },
    args.signal,
  );
  args.signal.throwIfAborted();
  if (commandHandled) {
    await markIngressProcessed(args.db, ingress.ingressId);
    return null;
  }

  const effectiveAgent = await resolveEffectiveFeishuAgent({
    db: args.db,
    installation,
    connection,
  });
  args.signal.throwIfAborted();
  if (effectiveAgent.status !== "resolved") {
    await replyFeishuAgentUnavailable({
      db: args.db,
      message,
      status: effectiveAgent.status,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
    await markIngressProcessed(args.db, ingress.ingressId);
    return null;
  }

  const modelRoute = await args.resolveModelRoute(
    installation.orgId,
    connection.vm0UserId,
    args.signal,
  );
  args.signal.throwIfAborted();
  const selectedModel = modelRoute?.selectedModel ?? null;
  const reactionId =
    ingress.reactionId ??
    (await addFeishuThinkingReaction({
      db: args.db,
      message,
      signal: args.signal,
    }));
  args.signal.throwIfAborted();
  if (reactionId && reactionId !== ingress.reactionId) {
    await args.db
      .update(feishuChatIngress)
      .set({ reactionId, updatedAt: nowDate() })
      .where(eq(feishuChatIngress.id, ingress.ingressId));
  }
  const history = await loadFeishuConversationHistory({
    db: args.db,
    message,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return await persistCanonicalFeishuIngress({
    db: args.db,
    ingress,
    installation,
    connection,
    message,
    agentId: effectiveAgent.agent.id,
    selectedModel,
    reactionId,
    files: history.files,
    appendSystemPrompt: buildFeishuSystemPrompt({
      message,
      history: history.text,
    }),
    signal: args.signal,
  });
}

export const processCanonicalFeishuIngress$ = command(
  async (
    { set },
    args: { readonly ingressId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const claimed = await claimIngress(db, args.ingressId, nowDate());
    signal.throwIfAborted();
    if (!claimed) {
      return false;
    }

    const result = await settle(
      processClaimedIngress({
        db,
        ingressId: args.ingressId,
        dispatchConnectedCommand: (context, inputSignal) => {
          return set(dispatchConnectedFeishuCommand$, context, inputSignal);
        },
        resolveModelRoute: (orgId, userId, inputSignal) => {
          return set(
            resolveIntegrationModelRouteForUser$,
            { orgId, userId },
            inputSignal,
          );
        },
        signal,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!result.ok) {
      await markIngressFailed(db, args.ingressId, result.error);
      signal.throwIfAborted();
      L.error("Failed to process canonical Feishu ingress", {
        ingressId: args.ingressId,
        error: result.error,
      });
      throw result.error;
    }
    if (!result.value) {
      return true;
    }
    L.debug("Canonical Feishu ingress persisted", {
      type: "canonical_feishu_ingress_processing",
      ingressId: args.ingressId,
      endToEndDurationMs: Math.max(
        0,
        now() - result.value.receivedAt.getTime(),
      ),
      success: true,
    });

    await publishChatThreadMessageCreatedSafely(
      result.value.userId,
      result.value.chatThreadId,
    );
    signal.throwIfAborted();
    await publishThreadListChanged(result.value.userId);
    signal.throwIfAborted();
    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: result.value.chatThreadId,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    await notifyQueuedFeishuRun({
      db,
      ingressId: args.ingressId,
      message: result.value.message,
      signal,
    });
    signal.throwIfAborted();
    return true;
  },
);

export const drainStaleCanonicalFeishuIngress$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const staleBefore = new Date(
      nowDate().getTime() - PROCESSING_STALE_AFTER_MS,
    );
    const rows = await db
      .select({ id: feishuChatIngress.id })
      .from(feishuChatIngress)
      .where(
        or(
          inArray(feishuChatIngress.status, ["pending", "failed"]),
          and(
            eq(feishuChatIngress.status, "processing"),
            lt(feishuChatIngress.updatedAt, staleBefore),
          ),
        ),
      )
      .orderBy(
        asc(feishuChatIngress.updatedAt),
        asc(feishuChatIngress.createdAt),
        asc(feishuChatIngress.id),
      )
      .limit(SWEEP_LIMIT);
    signal.throwIfAborted();

    let processed = 0;
    for (const row of rows) {
      const result = await settle(
        set(processCanonicalFeishuIngress$, { ingressId: row.id }, signal),
        signal,
      );
      signal.throwIfAborted();
      if (result.ok && result.value) {
        processed++;
      }
    }
    return processed;
  },
);
