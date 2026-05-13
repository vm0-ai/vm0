import { and, eq } from "drizzle-orm";
import { agentphoneThreadSessions } from "@vm0/db/schema/agentphone-thread-session";
import { agentphoneUserLinks } from "@vm0/db/schema/agentphone-user-link";
import { env } from "../../../../env";
import {
  sendAgentPhoneMessage,
  sendAgentPhoneTypingIndicator,
} from "../client";
import { AGENTPHONE_ROOT_MESSAGE_ID } from "../constants";
import {
  buildAgentPhoneConnectUrl,
  appendAgentPhoneSlashCommandRiskWarning,
  enrichAgentPhonePrompt,
  fetchAgentPhoneContext,
  lookupAgentPhoneThreadSession,
  resolveEffectiveAgentPhoneComposeId,
  type AgentPhoneMessageEvent,
  type AgentPhoneUserLink,
} from "../shared";
import {
  getAgentDisplayLabel,
  getWorkspaceAgent,
  resolveSessionCompose,
  resolveTelegramAuditLogsUrl,
} from "../../telegram/handlers/shared";
import { canReuseSessionForRunModel } from "../../context/session-model-compatibility";
import { formatAgentPhoneAuditLink } from "../footer";
import { handleAgentPhoneModelCommand } from "./model";
import { runAgentForAgentPhone } from "./run-agent";
import { logger } from "../../../shared/logger";

const log = logger("agentphone:inbound");

interface ResolvedAgentPhoneAgent {
  composeId: string;
  agentId: string;
  agentName: string;
}

function parseAgentPhoneCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const firstWord = trimmed.split(/\s/u)[0];
  if (!firstWord) return undefined;
  return firstWord.slice(1).toLowerCase();
}

async function sendAgentPhoneText(params: {
  event: AgentPhoneMessageEvent;
  body: string;
}): Promise<void> {
  await sendAgentPhoneMessage({
    agentphoneAgentId: params.event.agentphoneAgentId,
    toNumber: params.event.fromNumber,
    body: params.body,
  });
}

async function sendAgentPhoneSlashCommandText(params: {
  event: AgentPhoneMessageEvent;
  body: string;
}): Promise<void> {
  await sendAgentPhoneText({
    event: params.event,
    body: appendAgentPhoneSlashCommandRiskWarning(
      params.body,
      params.event.channel,
    ),
  });
}

async function refreshTypingIfSupported(
  event: AgentPhoneMessageEvent,
): Promise<void> {
  if (event.channel !== "imessage" || !event.conversationId) return;

  try {
    await sendAgentPhoneTypingIndicator({
      conversationId: event.conversationId,
    });
  } catch (error) {
    log.debug("Failed to send AgentPhone typing indicator", {
      conversationId: event.conversationId,
      error,
    });
  }
}

function formatConnectPrompt(event: AgentPhoneMessageEvent): string {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const connectUrl = buildAgentPhoneConnectUrl({
    phoneHandle: event.fromNumber,
    agentphoneAgentId: event.agentphoneAgentId,
    secret: SECRETS_ENCRYPTION_KEY,
    channel: event.channel,
  });

  return [
    "To use Zero by text message, connect this phone number to your VM0 account:",
    connectUrl,
  ].join("\n");
}

function formatHelpMessage(): string {
  return [
    "Zero text message commands",
    "",
    "/connect - Connect this phone number to VM0",
    "/new_session - Start a new conversation",
    "/model - Choose your model",
    "/disconnect - Disconnect this phone number from VM0",
    "/help - Show these commands",
    "",
    "Send a message to chat with Zero after connecting.",
  ].join("\n");
}

async function sendConnectPrompt(
  event: AgentPhoneMessageEvent,
  options?: { readonly slashCommand: boolean },
): Promise<void> {
  const body = formatConnectPrompt(event);
  await sendAgentPhoneText({
    event,
    body: options?.slashCommand
      ? appendAgentPhoneSlashCommandRiskWarning(body, event.channel)
      : body,
  });
}

async function resolveAgentPhoneAgent(
  userLink: AgentPhoneUserLink,
): Promise<ResolvedAgentPhoneAgent | undefined> {
  const composeId = await resolveEffectiveAgentPhoneComposeId(
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
  event: AgentPhoneMessageEvent;
  userLink: AgentPhoneUserLink | null;
}): Promise<void> {
  if (params.userLink) {
    await sendAgentPhoneSlashCommandText({
      event: params.event,
      body: "You are already connected. Send a message here to start chatting with Zero.",
    });
    return;
  }

  await sendConnectPrompt(params.event, { slashCommand: true });
}

async function handleDisconnectCommand(params: {
  event: AgentPhoneMessageEvent;
  userLink: AgentPhoneUserLink | null;
}): Promise<void> {
  if (!params.userLink) {
    await sendAgentPhoneSlashCommandText({
      event: params.event,
      body: "Error: This phone number is not connected.",
    });
    return;
  }

  await globalThis.services.db
    .delete(agentphoneUserLinks)
    .where(eq(agentphoneUserLinks.id, params.userLink.id));

  await sendAgentPhoneSlashCommandText({
    event: params.event,
    body: "This phone number has been disconnected from VM0.",
  });
}

async function handleNewSessionCommand(params: {
  event: AgentPhoneMessageEvent;
  userLink: AgentPhoneUserLink | null;
}): Promise<void> {
  if (!params.userLink) {
    await sendConnectPrompt(params.event, { slashCommand: true });
    return;
  }

  await globalThis.services.db
    .delete(agentphoneThreadSessions)
    .where(
      and(
        eq(agentphoneThreadSessions.agentphoneUserLinkId, params.userLink.id),
        eq(agentphoneThreadSessions.rootMessageId, AGENTPHONE_ROOT_MESSAGE_ID),
      ),
    );

  await sendAgentPhoneSlashCommandText({
    event: params.event,
    body: "New session started.",
  });

  log.info("AgentPhone session reset", {
    phoneHandle: params.userLink.phoneHandle,
    vm0UserId: params.userLink.vm0UserId,
    orgId: params.userLink.orgId,
  });
}

async function dispatchAgentPhoneCommand(params: {
  command: string | undefined;
  event: AgentPhoneMessageEvent;
  userLink: AgentPhoneUserLink | null;
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
      await sendAgentPhoneSlashCommandText({
        event: params.event,
        body: formatHelpMessage(),
      });
      return true;
    case "model":
      if (!params.userLink) {
        await sendConnectPrompt(params.event, { slashCommand: true });
        return true;
      }
      await handleAgentPhoneModelCommand({
        text: params.event.body,
        agentphoneAgentId: params.event.agentphoneAgentId,
        phoneHandle: params.event.fromNumber,
        channel: params.event.channel,
        orgId: params.userLink.orgId,
        userId: params.userLink.vm0UserId,
      });
      return true;
    default:
      return false;
  }
}

export async function handleAgentPhoneMessage(
  event: AgentPhoneMessageEvent,
  userLink: AgentPhoneUserLink | null,
  apiStartTime: number,
): Promise<void> {
  const command = parseAgentPhoneCommand(event.body);
  if (await dispatchAgentPhoneCommand({ command, event, userLink })) {
    return;
  }

  if (!userLink) {
    await sendConnectPrompt(event);
    return;
  }

  const agent = await resolveAgentPhoneAgent(userLink);
  if (!agent) {
    await sendAgentPhoneText({
      event,
      body: "The workspace default agent is not configured. Please choose an agent in VM0 first.",
    });
    return;
  }

  const session = await lookupAgentPhoneThreadSession(userLink.id);
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

  if (existingSessionId) {
    const canReuseSession = await canReuseSessionForRunModel({
      sessionId: existingSessionId,
      userId: userLink.vm0UserId,
      orgId: userLink.orgId,
      agentComposeId: agent.composeId,
    });
    if (!canReuseSession) {
      log.debug("Model changed, starting new AgentPhone session", {
        composeId: agent.composeId,
        existingSessionId,
      });
      existingSessionId = undefined;
      lastProcessedMessageId = undefined;
    }
  }

  const { executionContext } = await fetchAgentPhoneContext({
    userLinkId: userLink.id,
    phoneHandle: event.fromNumber,
    lastProcessedMessageId,
    currentMessageId: event.messageId,
  });
  const { prompt, userInfoExtras } = enrichAgentPhonePrompt(
    event.body,
    event.fromNumber,
    event.messageId,
    event.mediaUrl,
  );

  await refreshTypingIfSupported(event);

  const { status, response, runId } = await runAgentForAgentPhone({
    agentId: agent.agentId,
    agentName: agent.agentName,
    sessionId: existingSessionId,
    prompt,
    threadContext: executionContext,
    userInfoExtras,
    phoneHandle: event.fromNumber,
    conversationId: event.conversationId,
    channel: event.channel,
    messageId: event.messageId,
    agentphoneAgentId: event.agentphoneAgentId,
    userId: userLink.vm0UserId,
    apiStartTime,
    callbackContext: {
      messageId: event.messageId,
      conversationId: event.conversationId,
      channel: event.channel,
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
    await sendAgentPhoneText({
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
    await sendAgentPhoneText({
      event,
      body: [
        response ?? "An unexpected error occurred. Please try again later.",
        logsUrl ? formatAgentPhoneAuditLink(logsUrl) : null,
      ]
        .filter((part): part is string => {
          return Boolean(part);
        })
        .join("\n\n"),
    });
  }
}
