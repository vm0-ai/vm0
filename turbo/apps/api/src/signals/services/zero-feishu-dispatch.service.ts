import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
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

export const dispatchFeishuMessage$ = command(
  async (
    { set },
    message: FeishuInboundMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [installation] = await db
      .update(feishuOrgInstallations)
      .set({
        feishuTenantKey: message.tenantKey,
        messageReceivedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuOrgInstallations.id, message.installationId),
          eq(feishuOrgInstallations.appId, message.appId),
        ),
      )
      .returning({
        orgId: feishuOrgInstallations.orgId,
        defaultAgentId: feishuOrgInstallations.defaultComposeId,
      });
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("Feishu installation not found");
    }
    const [connection] = await db
      .select()
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

    const agent = await resolveAgent({
      db,
      orgId: installation.orgId,
      userId: connection.vm0UserId,
      agentId: installation.defaultAgentId,
    });
    signal.throwIfAborted();
    if (!agent) {
      await reply({
        db,
        message,
        text: "The configured Feishu agent is not accessible to this user. Ask an admin to select another agent.",
        signal,
      });
      return;
    }
    const sessionId = await resolveSession({
      db,
      connectionId: connection.id,
      chatId: message.chatId,
      userId: connection.vm0UserId,
      agentId: agent.id,
    });
    signal.throwIfAborted();

    const result = await set(
      createZeroIntegrationRun$,
      {
        userId: connection.vm0UserId,
        orgId: installation.orgId,
        agentId: agent.id,
        sessionId,
        prompt: message.text,
        appendSystemPrompt: systemPrompt(message),
        triggerSource: "feishu",
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        callbacks: [
          {
            internalKind: "feishu:org",
            secret: randomBytes(32).toString("hex"),
            payload: feishuOrgCallbackPayloadSchema.parse({
              installationId: message.installationId,
              chatId: message.chatId,
              messageId: message.messageId,
              connectionId: connection.id,
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
        db,
        message,
        text: result.body.error.message,
        signal,
      });
      return;
    }
    if (result.body.status === "queued") {
      await reply({
        db,
        message,
        text: "Your request is queued and will start automatically.",
        signal,
      });
    }
  },
);
