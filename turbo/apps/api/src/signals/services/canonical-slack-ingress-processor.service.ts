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
  formatCurrentMessageFiles,
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
  getMessagePermalink,
  setThreadStatus,
} from "../external/slack-message-client";
import { settle, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  attachCanonicalAssetsToMessage,
  materializeCanonicalSlackInputAssets$,
  type CanonicalSlackInputAsset,
} from "./canonical-asset.service";
import {
  canonicalSlackThreadStatusTargetForIngress,
  clearCanonicalSlackThreadStatusIfIdle,
} from "./canonical-slack-thread-status.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-message-shared.service";
import { insertChatEvent } from "./zero-chat-event.service";
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

function canonicalSlackFilesPrompt(
  files: readonly SlackFile[] | undefined,
  assets: readonly CanonicalSlackInputAsset[],
): string {
  if (!files || files.length === 0) {
    return "";
  }
  const assetByPosition = new Map(
    assets.map((asset) => {
      return [asset.position, asset] as const;
    }),
  );
  return files
    .flatMap((file, position) => {
      const asset = assetByPosition.get(position);
      if (asset?.status === "ready") {
        return [
          `[Web file] ${asset.filename} (${asset.contentType})\n   [ID] ${asset.assetId}`,
        ];
      }
      return [formatCurrentMessageFiles([file])];
    })
    .filter(Boolean)
    .join("\n");
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
  readonly channelId: string;
  readonly threadTs: string;
}

function persistedCanonicalSlackIngress(
  ingress: NonNullable<Awaited<ReturnType<typeof loadClaimedIngress>>>,
  chatThreadId: string,
): PersistedCanonicalSlackIngress {
  return {
    userId: ingress.userId,
    chatThreadId,
    channelId: ingress.channelId,
    threadTs: ingress.threadTs,
  };
}

async function setCanonicalSlackThinkingStatus(args: {
  readonly client: ReturnType<typeof createSlackClient>;
  readonly ingressId: string;
  readonly channelId: string;
  readonly threadTs: string;
}): Promise<void> {
  await tapError(
    setThreadStatus(
      args.client,
      args.channelId,
      args.threadTs,
      "is thinking...",
    ),
    (error) => {
      L.warn("Failed to set canonical Slack thinking status", {
        ingressId: args.ingressId,
        error,
      });
    },
  );
}

type ClaimedCanonicalSlackIngress = NonNullable<
  Awaited<ReturnType<typeof loadClaimedIngress>>
>;

async function persistCanonicalSlackMessage(
  db: Db,
  args: {
    readonly ingress: ClaimedCanonicalSlackIngress;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly displayContent: string;
    readonly messagePermalink: string | null;
    readonly canonicalAssets: readonly CanonicalSlackInputAsset[];
    readonly encryptedParams: Awaited<
      ReturnType<typeof encryptQueuedUserMessageRunParams>
    >;
  },
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    const inserted = await insertChatEvent(
      tx,
      {
        id: args.ingress.ingressId,
        chatThreadId: args.chatThreadId,
        eventType: "input.prompt",
        content: args.displayContent,
        runId: null,
        slackMessagePermalink: args.messagePermalink,
        createdAt: args.ingress.createdAt,
      },
      "id",
    );
    signal.throwIfAborted();
    if (!inserted) {
      throw new Error("Canonical Slack ingress message already exists");
    }
    await attachCanonicalAssetsToMessage(
      tx,
      args.ingress.ingressId,
      args.canonicalAssets,
    );
    await enqueueUserMessageQueueItem(tx, {
      orgId: args.orgId,
      userId: args.ingress.userId,
      chatThreadId: args.chatThreadId,
      chatMessageId: args.ingress.ingressId,
      triggerSource: "slack",
      encryptedParams: args.encryptedParams,
    });
    signal.throwIfAborted();
    await touchChatThreadLastMessageAt(
      tx,
      args.chatThreadId,
      args.ingress.createdAt,
      args.ingress.ingressId,
    );
    signal.throwIfAborted();
    await tx
      .update(slackChatIngress)
      .set({ status: "processed", lastError: null, updatedAt: nowDate() })
      .where(
        and(
          eq(slackChatIngress.id, args.ingress.ingressId),
          eq(slackChatIngress.status, "processing"),
        ),
      );
    signal.throwIfAborted();
  });
}

const persistClaimedCanonicalSlackIngress$ = command(
  async (
    { set },
    ingressId: string,
    signal: AbortSignal,
  ): Promise<PersistedCanonicalSlackIngress> => {
    const db = set(writeDb$);
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
    await setCanonicalSlackThinkingStatus({
      client,
      ingressId,
      channelId: ingress.channelId,
      threadTs: ingress.threadTs,
    });
    signal.throwIfAborted();
    const userInfoResolver = createSlackUserInfoResolver(client);
    const messageContent = stripBotMention(event.text, ingress.botUserId);
    const canonicalAssets = await set(
      materializeCanonicalSlackInputAssets$,
      {
        userId: ingress.userId,
        orgId,
        chatThreadId,
        workspaceId: ingress.workspaceId,
        channelId: ingress.channelId,
        messageTs: event.ts,
        botToken,
        files: event.files ?? [],
      },
      signal,
    );
    signal.throwIfAborted();
    const [enriched, context, permalinkResult] = await Promise.all([
      enrichMessageContent({
        messageContent,
        files: undefined,
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
      getMessagePermalink(client, event.channel, event.ts),
    ]);
    signal.throwIfAborted();
    const messagePermalink =
      permalinkResult.kind === "ok" ? permalinkResult.permalink : null;
    if (permalinkResult.kind === "slack_error") {
      L.warn("Failed to resolve canonical Slack message permalink", {
        ingressId,
        error: permalinkResult.error,
      });
    }
    const canonicalFilesPrompt = canonicalSlackFilesPrompt(
      event.files,
      canonicalAssets,
    );
    const agentPrompt = [enriched.prompt, canonicalFilesPrompt]
      .filter(Boolean)
      .join("\n\n");

    const encryptedParams = await encryptQueuedUserMessageRunParams(
      {
        version: 1,
        prompt: agentPrompt,
        appendSystemPrompt: buildSlackSystemPrompt({
          botUserId: ingress.botUserId,
          channelId: ingress.channelId,
          channelType: slackChannelType(event),
          threadTs: ingress.threadTs,
          executionContext: context.executionContext,
        }),
        slackDelivery: {
          channelId: ingress.channelId,
          threadTs: ingress.threadTs,
        },
        userInfoExtras: enriched.userInfoExtras,
      },
      { orgId, userId: ingress.userId },
    );
    signal.throwIfAborted();

    await persistCanonicalSlackMessage(
      db,
      {
        ingress,
        chatThreadId,
        orgId,
        displayContent: enriched.displayContent,
        messagePermalink,
        canonicalAssets,
        encryptedParams,
      },
      signal,
    );
    signal.throwIfAborted();
    return persistedCanonicalSlackIngress(ingress, chatThreadId);
  },
);

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
        const ingress = await set(
          persistClaimedCanonicalSlackIngress$,
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
        await tapError(
          clearCanonicalSlackThreadStatusIfIdle(
            db,
            {
              chatThreadId: ingress.chatThreadId,
              channelId: ingress.channelId,
              threadTs: ingress.threadTs,
            },
            signal,
          ),
          (error) => {
            L.warn("Failed to reconcile canonical Slack thread status", {
              ingressId: args.ingressId,
              error,
            });
          },
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
    await tapError(
      (async () => {
        const target = await canonicalSlackThreadStatusTargetForIngress(
          db,
          args.ingressId,
        );
        signal.throwIfAborted();
        if (target) {
          await clearCanonicalSlackThreadStatusIfIdle(db, target, signal);
        }
      })(),
      (error) => {
        L.warn("Failed to clear canonical Slack status after ingress failure", {
          ingressId: args.ingressId,
          error,
        });
      },
    );
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
