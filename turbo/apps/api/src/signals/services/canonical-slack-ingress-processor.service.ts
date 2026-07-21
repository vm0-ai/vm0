import { command } from "ccstate";
import { slackChatIngress } from "@vm0/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";

import { logger } from "../../lib/log";
import {
  enrichMessageContent,
  fetchConversationContexts,
  type SlackFile,
} from "../../lib/slack-webhook-context";
import { nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import {
  createSlackClient,
  createSlackUserInfoResolver,
} from "../external/slack-message-client";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-message-shared.service";
import { insertChatMessage } from "./zero-chat-message.service";
import {
  encryptQueuedUserMessageRunParams,
  enqueueUserMessageQueueItem,
} from "./zero-chat-queued-message.service";

const L = logger("CanonicalSlackIngressProcessor");
const PROCESSING_STALE_AFTER_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 20;

const slackAgentEventSchema = z.union([
  z.object({
    type: z.literal("app_mention"),
    user: z.string(),
    text: z.string(),
    ts: z.string(),
    channel: z.string(),
    channel_type: z.string().optional(),
    thread_ts: z.string().optional(),
    files: z.array(z.custom<SlackFile>()).optional(),
  }),
  z.object({
    type: z.literal("message"),
    channel_type: z.literal("im"),
    user: z.string(),
    text: z.string(),
    ts: z.string(),
    channel: z.string(),
    thread_ts: z.string().optional(),
    subtype: z.string().optional(),
    bot_id: z.string().optional(),
    files: z.array(z.custom<SlackFile>()).optional(),
  }),
]);

const slackEventCallbackSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  event_id: z.string(),
  event: slackAgentEventSchema,
});

type SlackAgentEvent = z.infer<typeof slackAgentEventSchema>;

function slackChannelType(
  event: SlackAgentEvent,
): "channel" | "dm" | "group_dm" {
  if (event.channel_type === "im") {
    return "dm";
  }
  if (event.channel_type === "mpim") {
    return "group_dm";
  }
  return "channel";
}

function buildSlackSystemPrompt(args: {
  readonly botUserId: string;
  readonly channelId: string;
  readonly channelType: "channel" | "dm" | "group_dm";
  readonly threadTs: string;
  readonly executionContext: string;
}): string {
  const typeLabel =
    args.channelType === "dm"
      ? "Direct message"
      : args.channelType === "group_dm"
        ? "Group direct message"
        : "Channel";
  return [
    "# Current Integration",
    "You are currently running inside: Slack",
    `Your bot user ID: ${args.botUserId}`,
    `Channel ID: ${args.channelId}`,
    `Channel type: ${typeLabel}`,
    `Thread ID: ${args.threadTs}`,
    args.executionContext,
  ]
    .filter(Boolean)
    .join("\n");
}

function stripBotMention(text: string, botUserId: string): string {
  return text.replaceAll(`<@${botUserId}>`, "").trim();
}

async function claimIngress(db: Db, ingressId: string, currentTime: Date) {
  const staleBefore = new Date(
    currentTime.getTime() - PROCESSING_STALE_AFTER_MS,
  );
  const [claimed] = await db
    .update(slackChatIngress)
    .set({
      status: "processing",
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(slackChatIngress.id, ingressId),
        or(
          inArray(slackChatIngress.status, ["pending", "failed"]),
          and(
            eq(slackChatIngress.status, "processing"),
            lt(slackChatIngress.updatedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({ id: slackChatIngress.id });
  return claimed !== undefined;
}

async function loadClaimedIngress(db: Db, ingressId: string) {
  const [row] = await db
    .select({
      ingressId: slackChatIngress.id,
      payload: slackChatIngress.payload,
      createdAt: slackChatIngress.createdAt,
      routeId: slackChatThreadRoutes.id,
      channelId: slackChatThreadRoutes.channelId,
      threadTs: slackChatThreadRoutes.threadTs,
      chatThreadId: slackChatThreadRoutes.chatThreadId,
      userId: slackChatThreadRoutes.userId,
      connectionId: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
      workspaceId: slackOrgConnections.slackWorkspaceId,
      orgId: slackOrgInstallations.orgId,
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
      botUserId: slackOrgInstallations.botUserId,
    })
    .from(slackChatIngress)
    .innerJoin(
      slackChatThreadRoutes,
      eq(slackChatIngress.routeId, slackChatThreadRoutes.id),
    )
    .innerJoin(
      slackOrgConnections,
      eq(slackChatThreadRoutes.connectionId, slackOrgConnections.id),
    )
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgConnections.slackWorkspaceId,
        slackOrgInstallations.slackWorkspaceId,
      ),
    )
    .where(
      and(
        eq(slackChatIngress.id, ingressId),
        eq(slackChatIngress.status, "processing"),
        eq(slackChatThreadRoutes.backend, "canonical"),
      ),
    )
    .limit(1);
  return row;
}

function requireMatchingEvent(
  payload: string,
  route: NonNullable<Awaited<ReturnType<typeof loadClaimedIngress>>>,
) {
  const parsed = slackEventCallbackSchema.parse(JSON.parse(payload) as unknown);
  const event = parsed.event;
  if (
    parsed.team_id !== route.workspaceId ||
    event.user !== route.slackUserId ||
    event.channel !== route.channelId ||
    (event.thread_ts ?? event.ts) !== route.threadTs
  ) {
    throw new Error("Canonical Slack ingress payload does not match its route");
  }
  if (
    event.type === "message" &&
    (event.bot_id || (event.subtype && event.subtype !== "file_share"))
  ) {
    throw new Error("Canonical Slack ingress payload is not a user message");
  }
  return event;
}

async function markIngressFailed(
  db: Db,
  ingressId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Unknown error";
  await db
    .update(slackChatIngress)
    .set({
      status: "failed",
      lastError: message.slice(0, 4000),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(slackChatIngress.id, ingressId),
        eq(slackChatIngress.status, "processing"),
      ),
    );
}

interface PersistedCanonicalSlackIngress {
  readonly userId: string;
  readonly chatThreadId: string;
}

async function persistClaimedCanonicalSlackIngress(
  db: Db,
  ingressId: string,
  signal: AbortSignal,
): Promise<PersistedCanonicalSlackIngress> {
  const ingress = await loadClaimedIngress(db, ingressId);
  signal.throwIfAborted();
  if (!ingress?.chatThreadId || !ingress.orgId) {
    throw new Error("Canonical Slack ingress route is incomplete");
  }
  const chatThreadId = ingress.chatThreadId;
  const orgId = ingress.orgId;
  const event = requireMatchingEvent(ingress.payload, ingress);
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    orgId,
    ingress.userId,
  );
  signal.throwIfAborted();
  const botToken = await decryptPersistentSecretValue(
    ingress.encryptedBotToken,
    featureContext,
  );
  signal.throwIfAborted();
  const client = createSlackClient(botToken);
  const userInfoResolver = createSlackUserInfoResolver(client);
  const messageContent = stripBotMention(event.text, ingress.botUserId);
  const [enriched, context] = await Promise.all([
    enrichMessageContent({
      messageContent,
      files: event.files,
      client,
      userId: event.user,
      userInfoResolver,
    }),
    fetchConversationContexts(
      client,
      event.channel,
      event.thread_ts,
      event.ts,
      { userInfoResolver },
    ),
  ]);
  signal.throwIfAborted();

  const encryptedParams = await encryptQueuedUserMessageRunParams(
    {
      version: 1,
      prompt: enriched.prompt,
      appendSystemPrompt: buildSlackSystemPrompt({
        botUserId: ingress.botUserId,
        channelId: ingress.channelId,
        channelType: slackChannelType(event),
        threadTs: ingress.threadTs,
        executionContext: context.executionContext,
      }),
      userInfoExtras: enriched.userInfoExtras,
    },
    { orgId, userId: ingress.userId },
  );
  signal.throwIfAborted();

  await db.transaction(async (tx) => {
    const inserted = await insertChatMessage(
      tx,
      {
        id: ingress.ingressId,
        chatThreadId,
        role: "user",
        content: enriched.displayContent,
        runId: null,
        createdAt: ingress.createdAt,
      },
      "id",
    );
    signal.throwIfAborted();
    if (!inserted) {
      throw new Error("Canonical Slack ingress message already exists");
    }
    await enqueueUserMessageQueueItem(tx, {
      orgId,
      userId: ingress.userId,
      chatThreadId,
      chatMessageId: ingress.ingressId,
      triggerSource: "slack",
      encryptedParams,
    });
    signal.throwIfAborted();
    await touchChatThreadLastMessageAt(
      tx,
      chatThreadId,
      ingress.createdAt,
      ingress.ingressId,
    );
    signal.throwIfAborted();
    await tx
      .update(slackChatIngress)
      .set({ status: "processed", lastError: null, updatedAt: nowDate() })
      .where(
        and(
          eq(slackChatIngress.id, ingress.ingressId),
          eq(slackChatIngress.status, "processing"),
        ),
      );
    signal.throwIfAborted();
  });
  signal.throwIfAborted();
  return { userId: ingress.userId, chatThreadId };
}

export const processCanonicalSlackIngress$ = command(
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
      (async () => {
        const ingress = await persistClaimedCanonicalSlackIngress(
          db,
          args.ingressId,
          signal,
        );
        signal.throwIfAborted();
        await publishChatThreadMessageCreatedSafely(
          ingress.userId,
          ingress.chatThreadId,
        );
        signal.throwIfAborted();
        await publishThreadListChanged(ingress.userId);
        signal.throwIfAborted();
        await set(
          drainChatThreadQueueForThread$,
          {
            chatThreadId: ingress.chatThreadId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          },
          signal,
        );
        signal.throwIfAborted();
        return true;
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }

    await markIngressFailed(db, args.ingressId, result.error);
    signal.throwIfAborted();
    L.error("Failed to process canonical Slack ingress", {
      ingressId: args.ingressId,
      error: result.error,
    });
    throw result.error;
  },
);

export const drainStaleCanonicalSlackIngress$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const staleBefore = new Date(
      nowDate().getTime() - PROCESSING_STALE_AFTER_MS,
    );
    const rows = await db
      .select({ id: slackChatIngress.id })
      .from(slackChatIngress)
      .where(
        or(
          inArray(slackChatIngress.status, ["pending", "failed"]),
          and(
            eq(slackChatIngress.status, "processing"),
            lt(slackChatIngress.updatedAt, staleBefore),
          ),
        ),
      )
      .orderBy(
        asc(slackChatIngress.updatedAt),
        asc(slackChatIngress.createdAt),
        asc(slackChatIngress.id),
      )
      .limit(SWEEP_LIMIT);
    signal.throwIfAborted();

    let processed = 0;
    for (const row of rows) {
      const result = await settle(
        set(processCanonicalSlackIngress$, { ingressId: row.id }, signal),
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
