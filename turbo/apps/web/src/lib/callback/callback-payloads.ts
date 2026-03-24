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
  agentName: string;
  composeId: string;
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
  agentName: string;
  composeId: string;
  existingSessionId?: string;
}

export interface EmailTriggerCallbackPayload {
  senderEmail: string;
  composeId: string;
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

export interface EmailScheduleCallbackPayload {
  scheduleId: string;
  agentId: string;
  agentName: string;
  userId: string;
}

export interface SlackScheduleCallbackPayload {
  scheduleId: string;
  agentId: string;
  agentName: string;
  userId: string;
  orgId: string;
}

export interface ScheduleLoopCallbackPayload {
  scheduleId: string;
  intervalSeconds: number;
}

export interface GitHubIssuesCallbackPayload {
  installationId: string;
  repo: string;
  issueNumber: number;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
  triggerCommentId?: string;
  triggerCommentBody?: string;
  triggerReactionId?: string;
}

export type CallbackPayload =
  | TelegramCallbackPayload
  | SlackOrgCallbackPayload
  | EmailTriggerCallbackPayload
  | EmailReplyCallbackPayload
  | EmailScheduleCallbackPayload
  | SlackScheduleCallbackPayload
  | ScheduleLoopCallbackPayload
  | GitHubIssuesCallbackPayload;
