/**
 * Shared callback payload types for all zero-layer channels.
 *
 * Each interface defines the payload shape passed from the registration handler
 * to the callback consumer route. These types provide compile-time safety while
 * the parsePayload() functions in each route provide runtime validation.
 */

export interface TelegramCallbackPayload {
  installationId: string;
  chatId: string;
  messageId: string;
  rootMessageId: string | null;
  userLinkId: string;
  agentId: string;
  existingSessionId: string | null;
  isDM: boolean;
  thinkingMessageId: string | null;
}

export interface SlackOrgCallbackPayload {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
  agentId: string;
  existingSessionId?: string;
}

export interface EmailTriggerCallbackPayload {
  senderEmail: string;
  agentId: string;
  userId: string;
  inboundEmailId: string;
  replyToken: string;
  inboundMessageId?: string;
  inboundReferences?: string;
  subject?: string;
  runtimeOrgId?: string;
  replyRecipientTo?: string[];
  replyRecipientCc?: string[];
}

export interface EmailReplyCallbackPayload {
  emailThreadSessionId: string;
  inboundEmailId: string;
  inboundMessageId?: string;
  inboundReferences?: string;
  replyRecipientTo?: string[];
  replyRecipientCc?: string[];
}

export interface ScheduleLoopCallbackPayload {
  scheduleId: string;
}

export interface ScheduleCronCallbackPayload {
  scheduleId: string;
  cronExpression?: string;
  timezone: string;
}

export interface GitHubIssuesCallbackPayload {
  installationId: string;
  repo: string;
  issueNumber: number;
  agentId: string;
  existingSessionId?: string;
  triggerCommentId?: string;
  triggerCommentBody?: string;
  triggerReactionId?: string;
}

export interface ChatCallbackPayload {
  threadId: string;
  agentId: string;
}

export interface VoiceChatCallbackPayload {
  sessionId: string;
}

/**
 * Consumed by the Wave 5 callback route /api/internal/callbacks/voice-chat-candidate
 * (Epic #10297, sub-issue #10311). Declared here ahead of the route handler so
 * the contract and service layers that land in Wave 1–4 can import it.
 * @public
 */
export interface VoiceChatCandidateCallbackPayload {
  taskId: string;
}

export interface PhoneCallbackPayload {
  callId: string;
  userId: string;
  orgId: string;
  agentId: string;
  existingSessionId: string | null;
}

export interface IMessageCallbackPayload {
  messageId: string;
  fromNumber: string;
  userId: string;
  orgId: string;
  agentId: string;
  agentphoneAgentId: string;
  existingSessionId: string | null;
}
