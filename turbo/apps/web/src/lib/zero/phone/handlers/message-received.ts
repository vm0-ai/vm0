import {
  resolveOrgByAgentphoneAgentId,
  resolveUserByIMessageHandle,
  lookupIMessageThreadSession,
} from "./imessage-shared";
import { runAgentForIMessage } from "./run-agent-imessage";
import { sendIMessage } from "../imessage-service";
import { buildConnectUrl } from "../imessage-connect-token";
import type { IMessageCallbackPayload } from "../../../infra/callback/callback-payloads";
import { logger } from "../../../shared/logger";

const log = logger("imessage:message-received");

interface MessageReceivedEvent {
  messageId: string;
  agentId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  channel: string;
}

/**
 * Handle an AgentPhone agent.message webhook event for iMessage/SMS.
 *
 * Flow:
 * 1. Resolve org from AgentPhone agent ID
 * 2. Look up iMessage user binding
 * 3. If unbound → send connect/binding link
 * 4. If bound → create agent run with message as prompt
 */
export async function handleMessageReceived(
  event: MessageReceivedEvent,
): Promise<void> {
  const { messageId, agentId: apAgentId, fromNumber, body, channel } = event;

  // Resolve org from AgentPhone agent ID
  const org = await resolveOrgByAgentphoneAgentId(apAgentId);
  if (!org) {
    log.warn("No org found for AgentPhone agent", { apAgentId, messageId });
    return;
  }

  if (!org.defaultAgentId) {
    log.warn("Org has no default agent configured", {
      orgId: org.orgId,
      messageId,
    });
    return;
  }

  // Look up user binding by iMessage handle (phone number)
  const userLink = await resolveUserByIMessageHandle(fromNumber);

  if (!userLink || userLink.orgId !== org.orgId) {
    // User is not bound to this org — send binding link
    log.info("Message from unbound iMessage handle, sending connect link", {
      fromNumber,
      orgId: org.orgId,
      messageId,
    });

    const connectUrl = buildConnectUrl(fromNumber, org.orgId);
    await sendIMessage({
      agentId: org.agentphoneAgentId,
      toNumber: fromNumber,
      body: `Welcome! To get started, please link your account:\n${connectUrl}`,
    });
    return;
  }

  const userId = userLink.vm0UserId;

  // Dedup check
  const existingSession = await lookupIMessageThreadSession(userId, org.orgId);
  if (existingSession?.lastMessageId === messageId) {
    log.debug("Duplicate message event, skipping", { messageId });
    return;
  }

  const callbackPayload: IMessageCallbackPayload = {
    messageId,
    fromNumber,
    userId,
    orgId: org.orgId,
    agentId: org.defaultAgentId,
    agentphoneAgentId: org.agentphoneAgentId,
    existingSessionId: existingSession?.agentSessionId ?? null,
  };

  await runAgentForIMessage({
    agentId: org.defaultAgentId,
    sessionId: existingSession?.agentSessionId,
    prompt: body,
    fromNumber,
    userId,
    callbackContext: callbackPayload,
  });

  log.info("iMessage run dispatched", {
    messageId,
    orgId: org.orgId,
    channel,
  });
}
