import { and, eq } from "drizzle-orm";
import { imessageThreadSessions } from "@vm0/db/schema/imessage-thread-session";
import { imessageUserLinks } from "@vm0/db/schema/imessage-user-link";
import { env } from "../../../../env";
import { sendAgentPhoneMessage } from "../client";
import { IMESSAGE_ROOT_MESSAGE_ID } from "../constants";
import {
  buildIMessageConnectUrl,
  enrichIMessagePrompt,
  fetchIMessageContext,
  lookupIMessageThreadSession,
  resolveEffectiveIMessageComposeId,
  type AgentPhoneIMessageEvent,
  type IMessageUserLink,
} from "../shared";
import {
  getAgentDisplayLabel,
  getWorkspaceAgent,
  resolveSessionCompose,
  resolveTelegramAuditLogsUrl,
} from "../../telegram/handlers/shared";
import { handleIMessageModelCommand } from "./model";
import { runAgentForIMessage } from "./run-agent";
import { logger } from "../../../shared/logger";

const log = logger("imessage:inbound");

interface ResolvedIMessageAgent {
  composeId: string;
  agentId: string;
  agentName: string;
}

function parseIMessageCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const firstWord = trimmed.split(/\s/u)[0];
  if (!firstWord) return undefined;
  return firstWord.slice(1).toLowerCase();
}

async function sendIMessageText(params: {
  event: AgentPhoneIMessageEvent;
  body: string;
}): Promise<void> {
  await sendAgentPhoneMessage({
    agentphoneAgentId: params.event.agentphoneAgentId,
    toNumber: params.event.fromNumber,
    body: params.body,
  });
}

function formatConnectPrompt(event: AgentPhoneIMessageEvent): string {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const connectUrl = buildIMessageConnectUrl({
    phoneHandle: event.fromNumber,
    agentphoneAgentId: event.agentphoneAgentId,
    secret: SECRETS_ENCRYPTION_KEY,
  });

  return [
    "To use Zero over iMessage, connect this phone number to your VM0 account:",
    connectUrl,
  ].join("\n");
}

function formatHelpMessage(): string {
  return [
    "Zero iMessage commands",
    "",
    "/connect - Connect this phone number to VM0",
    "/new_session - Start a new conversation",
    "/model - Choose your personal default model",
    "/disconnect - Disconnect this phone number from VM0",
    "/help - Show these commands",
    "",
    "Send a message to chat with Zero after connecting.",
  ].join("\n");
}

async function sendConnectPrompt(
  event: AgentPhoneIMessageEvent,
): Promise<void> {
  await sendIMessageText({
    event,
    body: formatConnectPrompt(event),
  });
}

async function resolveIMessageAgent(
  userLink: IMessageUserLink,
): Promise<ResolvedIMessageAgent | undefined> {
  const composeId = await resolveEffectiveIMessageComposeId(
    userLink.vm0UserId,
    userLink.orgId,
  );
  if (!composeId) return undefined;

  const agent = await getWorkspaceAgent(composeId);
  if (!agent) return undefined;

  return {
    composeId,
    agentId: agent.agentId,
    agentName: getAgentDisplayLabel(agent),
  };
}

async function handleConnectCommand(params: {
  event: AgentPhoneIMessageEvent;
  userLink: IMessageUserLink | null;
}): Promise<void> {
  if (params.userLink) {
    await sendIMessageText({
      event: params.event,
      body: "You are already connected. Send a message here to start chatting with Zero.",
    });
    return;
  }

  await sendConnectPrompt(params.event);
}

async function handleDisconnectCommand(params: {
  event: AgentPhoneIMessageEvent;
  userLink: IMessageUserLink | null;
}): Promise<void> {
  if (!params.userLink) {
    await sendIMessageText({
      event: params.event,
      body: "Error: This phone number is not connected.",
    });
    return;
  }

  await globalThis.services.db
    .delete(imessageUserLinks)
    .where(eq(imessageUserLinks.id, params.userLink.id));

  await sendIMessageText({
    event: params.event,
    body: "This phone number has been disconnected from VM0.",
  });
}

async function handleNewSessionCommand(params: {
  event: AgentPhoneIMessageEvent;
  userLink: IMessageUserLink | null;
}): Promise<void> {
  if (!params.userLink) {
    await sendConnectPrompt(params.event);
    return;
  }

  await globalThis.services.db
    .delete(imessageThreadSessions)
    .where(
      and(
        eq(imessageThreadSessions.imessageUserLinkId, params.userLink.id),
        eq(imessageThreadSessions.rootMessageId, IMESSAGE_ROOT_MESSAGE_ID),
      ),
    );

  await sendIMessageText({
    event: params.event,
    body: "New session started.",
  });

  log.info("iMessage session reset", {
    phoneHandle: params.userLink.phoneHandle,
    vm0UserId: params.userLink.vm0UserId,
    orgId: params.userLink.orgId,
  });
}

async function dispatchIMessageCommand(params: {
  command: string | undefined;
  event: AgentPhoneIMessageEvent;
  userLink: IMessageUserLink | null;
}): Promise<boolean> {
  switch (params.command) {
    case "connect":
      await handleConnectCommand(params);
      return true;
    case "disconnect":
      await handleDisconnectCommand(params);
      return true;
    case "new_session":
      await handleNewSessionCommand(params);
      return true;
    case "help":
      await sendIMessageText({
        event: params.event,
        body: formatHelpMessage(),
      });
      return true;
    case "model":
      if (!params.userLink) {
        await sendConnectPrompt(params.event);
        return true;
      }
      await handleIMessageModelCommand({
        text: params.event.body,
        agentphoneAgentId: params.event.agentphoneAgentId,
        phoneHandle: params.event.fromNumber,
        orgId: params.userLink.orgId,
        userId: params.userLink.vm0UserId,
      });
      return true;
    default:
      return false;
  }
}

export async function handleAgentPhoneIMessage(
  event: AgentPhoneIMessageEvent,
  userLink: IMessageUserLink | null,
  apiStartTime: number,
): Promise<void> {
  const command = parseIMessageCommand(event.body);
  if (await dispatchIMessageCommand({ command, event, userLink })) {
    return;
  }

  if (!userLink) {
    await sendConnectPrompt(event);
    return;
  }

  const agent = await resolveIMessageAgent(userLink);
  if (!agent) {
    await sendIMessageText({
      event,
      body: "The workspace default agent is not configured. Please choose an agent in VM0 first.",
    });
    return;
  }

  const session = await lookupIMessageThreadSession(userLink.id);
  let existingSessionId = session.existingSessionId;
  let lastProcessedMessageId = session.lastProcessedMessageId;

  if (existingSessionId) {
    const sessionCompose = await resolveSessionCompose(
      existingSessionId,
      userLink.vm0UserId,
    );
    if (sessionCompose && sessionCompose.composeId !== agent.composeId) {
      existingSessionId = undefined;
      lastProcessedMessageId = undefined;
    }
  }

  const { executionContext } = await fetchIMessageContext({
    phoneHandle: event.fromNumber,
    lastProcessedMessageId,
    currentMessageId: event.messageId,
  });
  const { prompt, userInfoExtras } = enrichIMessagePrompt(
    event.body,
    event.fromNumber,
    event.mediaUrl,
  );

  const { status, response, runId } = await runAgentForIMessage({
    agentId: agent.agentId,
    agentName: agent.agentName,
    sessionId: existingSessionId,
    prompt,
    threadContext: executionContext,
    userInfoExtras,
    phoneHandle: event.fromNumber,
    conversationId: event.conversationId,
    messageId: event.messageId,
    userId: userLink.vm0UserId,
    apiStartTime,
    callbackContext: {
      messageId: event.messageId,
      conversationId: event.conversationId,
      phoneHandle: event.fromNumber,
      fromNumber: event.fromNumber,
      toNumber: event.toNumber,
      userLinkId: userLink.id,
      agentId: agent.composeId,
      agentphoneAgentId: event.agentphoneAgentId,
      existingSessionId: existingSessionId ?? null,
    },
  });

  if (status === "queued") {
    await sendIMessageText({
      event,
      body: "Run queued because the concurrency limit was reached. It will start automatically when a slot is available.",
    });
    return;
  }

  if (status === "failed") {
    const logsUrl = await resolveTelegramAuditLogsUrl({
      orgId: userLink.orgId,
      userId: userLink.vm0UserId,
      runId,
    });
    await sendIMessageText({
      event,
      body: [
        response ?? "An unexpected error occurred. Please try again later.",
        logsUrl ? `View run: ${logsUrl}` : null,
      ]
        .filter((part): part is string => {
          return Boolean(part);
        })
        .join("\n\n"),
    });
  }
}
