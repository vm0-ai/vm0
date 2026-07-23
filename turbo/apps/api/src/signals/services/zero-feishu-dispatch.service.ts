import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { feishuOrgThreadSessions } from "@vm0/db/schema/feishu-org-thread-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { now, nowDate } from "../external/time";
import { replyToFeishuMessage } from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { buildFeishuConnectUrl } from "./feishu-connect-token";
import { feishuOrgCallbackPayloadSchema } from "./feishu-org-callback-payload";
import { publishFeishuOrgChanged } from "./zero-feishu-realtime.service";
import { createZeroIntegrationRun$ } from "./zero-runs-create.service";

export interface FeishuInboundMessage {
  readonly installationId: string;
  readonly eventId: string;
  readonly tenantKey: string;
  readonly appId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly openId: string;
  readonly text: string;
}

interface FeishuAgent {
  readonly id: string;
}

interface FeishuDispatchInstallation {
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
  readonly messageReceivedAt: Date | null;
}

interface FeishuDispatchConnection {
  readonly id: string;
  readonly vm0UserId: string;
}

async function resolveAgent(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<FeishuAgent | null> {
  const [agent] = await args.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, args.agentId),
        eq(zeroAgents.orgId, args.orgId),
        or(
          eq(zeroAgents.visibility, "public"),
          eq(zeroAgents.owner, args.userId),
        ),
      ),
    )
    .limit(1);
  return agent ?? null;
}

async function resolveSession(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly agentId: string;
}): Promise<string | undefined> {
  const [thread] = await args.db
    .select({ agentSessionId: feishuOrgThreadSessions.agentSessionId })
    .from(feishuOrgThreadSessions)
    .where(
      and(
        eq(feishuOrgThreadSessions.connectionId, args.connectionId),
        eq(feishuOrgThreadSessions.feishuChatId, args.chatId),
      ),
    )
    .limit(1);
  if (!thread?.agentSessionId) {
    return undefined;
  }
  const [session] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, thread.agentSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  return session?.agentComposeId === args.agentId
    ? thread.agentSessionId
    : undefined;
}

function systemPrompt(message: FeishuInboundMessage): string {
  return [
    "# Current Integration",
    "You are currently running inside: Feishu",
    "Scope: Direct message",
    `Tenant key: ${message.tenantKey}`,
    `Chat ID: ${message.chatId}`,
    `Message ID: ${message.messageId}`,
    `Sender open ID: ${message.openId}`,
  ].join("\n");
}

async function reply(args: {
  readonly db: Db;
  readonly message: FeishuInboundMessage;
  readonly text: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await replyToFeishuMessage({
    db: args.db,
    installationId: args.message.installationId,
    messageId: args.message.messageId,
    text: args.text,
    signal: args.signal,
  });
}

async function markFeishuMessageReceived(args: {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly message: FeishuInboundMessage;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.installation.messageReceivedAt) {
    return;
  }
  const [markedAsReceived] = await args.db
    .update(feishuOrgInstallations)
    .set({
      feishuTenantKey: args.message.tenantKey,
      messageReceivedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(feishuOrgInstallations.id, args.message.installationId),
        isNull(feishuOrgInstallations.messageReceivedAt),
      ),
    )
    .returning({ id: feishuOrgInstallations.id });
  args.signal.throwIfAborted();
  if (markedAsReceived) {
    await publishFeishuOrgChanged(
      args.db,
      args.installation.orgId,
      args.installation.ownerUserId,
    );
  }
}

const dispatchConnectedFeishuMessage$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly installation: FeishuDispatchInstallation;
      readonly connection: FeishuDispatchConnection;
      readonly message: FeishuInboundMessage;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const agent = await resolveAgent({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
      agentId: args.installation.defaultAgentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      await reply({
        db: args.db,
        message: args.message,
        text: "The configured Feishu agent is not accessible to this user. Ask an admin to select another agent.",
        signal,
      });
      return;
    }
    const sessionId = await resolveSession({
      db: args.db,
      connectionId: args.connection.id,
      chatId: args.message.chatId,
      userId: args.connection.vm0UserId,
      agentId: agent.id,
    });
    signal.throwIfAborted();
    const result = await set(
      createZeroIntegrationRun$,
      {
        userId: args.connection.vm0UserId,
        orgId: args.installation.orgId,
        agentId: agent.id,
        sessionId,
        prompt: args.message.text,
        appendSystemPrompt: systemPrompt(args.message),
        triggerSource: "feishu",
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        callbacks: [
          {
            internalKind: "feishu:org",
            secret: randomBytes(32).toString("hex"),
            payload: feishuOrgCallbackPayloadSchema.parse({
              installationId: args.message.installationId,
              chatId: args.message.chatId,
              messageId: args.message.messageId,
              connectionId: args.connection.id,
            }),
          },
        ],
        apiStartTime: now(),
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status !== 201) {
      await reply({
        db: args.db,
        message: args.message,
        text: result.body.error.message,
        signal,
      });
      return;
    }
    if (result.body.status === "queued") {
      await reply({
        db: args.db,
        message: args.message,
        text: "Your request is queued and will start automatically.",
        signal,
      });
    }
  },
);

export const dispatchFeishuMessage$ = command(
  async (
    { set },
    message: FeishuInboundMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({
        orgId: feishuOrgInstallations.orgId,
        ownerUserId: feishuOrgInstallations.ownerUserId,
        defaultAgentId: feishuOrgInstallations.defaultComposeId,
        messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
      })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, message.installationId),
          eq(feishuOrgInstallations.appId, message.appId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("Feishu installation not found");
    }
    await markFeishuMessageReceived({
      db,
      installation,
      message,
      signal,
    });
    const [connection] = await db
      .select({
        id: feishuOrgConnections.id,
        vm0UserId: feishuOrgConnections.vm0UserId,
      })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, message.installationId),
          eq(feishuOrgConnections.feishuOpenId, message.openId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connection) {
      const connectUrl = buildFeishuConnectUrl({
        installationId: message.installationId,
        openId: message.openId,
        chatId: message.chatId,
      });
      await reply({
        db,
        message,
        text: `Please connect your VM0 account first:\n${connectUrl}`,
        signal,
      });
      return;
    }

    await set(
      dispatchConnectedFeishuMessage$,
      {
        db,
        installation,
        connection,
        message,
      },
      signal,
    );
  },
);
