import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { feishuOrgThreadSessions } from "@vm0/db/schema/feishu-org-thread-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import { now, nowDate } from "../external/time";
import { replyToFeishuMessage } from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { buildFeishuConnectUrl } from "./feishu-connect-token";
import { feishuConfig } from "./feishu-config";
import { feishuOrgCallbackPayloadSchema } from "./feishu-org-callback-payload";
import { createZeroIntegrationRun$ } from "./zero-runs-create.service";

export interface FeishuInboundMessage {
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
}): Promise<FeishuAgent | null> {
  const [metadata] = await args.db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, args.orgId))
    .limit(1);
  if (!metadata?.defaultAgentId) {
    return null;
  }
  const [agent] = await args.db
    .select({
      id: zeroAgents.id,
    })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, metadata.defaultAgentId),
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
  const config = feishuConfig();
  if (!config) {
    throw new Error("Feishu integration is not configured");
  }
  await replyToFeishuMessage({
    db: args.db,
    config,
    tenantKey: args.message.tenantKey,
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
    await db
      .insert(feishuOrgInstallations)
      .values({
        feishuTenantKey: message.tenantKey,
        feishuAppId: message.appId,
      })
      .onConflictDoUpdate({
        target: feishuOrgInstallations.feishuTenantKey,
        set: { feishuAppId: message.appId, updatedAt: nowDate() },
      });
    signal.throwIfAborted();

    const [installation] = await db
      .select()
      .from(feishuOrgInstallations)
      .where(eq(feishuOrgInstallations.feishuTenantKey, message.tenantKey))
      .limit(1);
    signal.throwIfAborted();
    const [connection] = await db
      .select()
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.feishuTenantKey, message.tenantKey),
          eq(feishuOrgConnections.feishuOpenId, message.openId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!installation?.orgId || !connection) {
      const connectUrl = buildFeishuConnectUrl({
        tenantKey: message.tenantKey,
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
    });
    signal.throwIfAborted();
    if (!agent) {
      await reply({
        db,
        message,
        text: "No accessible default agent is configured for this organization. Please ask an admin to configure one.",
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
              tenantKey: message.tenantKey,
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
