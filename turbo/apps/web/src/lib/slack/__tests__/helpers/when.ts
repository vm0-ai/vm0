/**
 * BDD "When" Helpers - Action helpers for Slack tests
 *
 * These helpers execute the actions being tested.
 * They follow the "When" step pattern in BDD tests.
 */
import { handleAppMention } from "../../handlers/mention";
import { runAgentForSlack } from "../../handlers/run-agent";
import {
  linkSlackAccount,
  checkLinkStatus,
} from "../../../../../app/slack/link/actions";

/**
 * Context for app mention events
 */
export interface MentionContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  messageText: string;
  messageTs: string;
  threadTs?: string;
}

/**
 * When a user @mentions the VM0 bot.
 * Calls the handleAppMention handler directly.
 */
export async function whenUserMentionsBot(
  context: MentionContext,
): Promise<void> {
  await handleAppMention(context);
}

/**
 * When runAgentForSlack is called.
 * Executes the agent run flow.
 */
export async function whenRunAgentForSlack(params: {
  binding: {
    id: string;
    composeId: string;
    encryptedSecrets: string | null;
  };
  sessionId: string | undefined;
  prompt: string;
  threadContext: string;
  userId: string;
  encryptionKey: string;
}): Promise<{ response: string; sessionId?: string }> {
  return runAgentForSlack(params);
}

/**
 * When a user links their Slack account.
 * Calls the linkSlackAccount server action.
 */
export async function whenUserLinksAccount(
  slackUserId: string,
  workspaceId: string,
): Promise<{
  success: boolean;
  error?: string;
  alreadyLinked?: boolean;
}> {
  return linkSlackAccount(slackUserId, workspaceId);
}

/**
 * When checking a user's link status.
 * Calls the checkLinkStatus server action.
 */
export async function whenCheckLinkStatus(
  slackUserId: string,
  workspaceId: string,
): Promise<{
  isLinked: boolean;
  workspaceName?: string;
}> {
  return checkLinkStatus(slackUserId, workspaceId);
}
