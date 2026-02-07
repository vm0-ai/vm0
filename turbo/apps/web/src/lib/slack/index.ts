// Slack integration utilities

import { env } from "../../env";

/**
 * Get the base URL for Slack OAuth redirects
 * Uses SLACK_REDIRECT_BASE_URL env var, or derives from request URL
 *
 * @param requestUrl - Optional request URL to derive base URL from
 * @returns Base URL for redirects
 * @throws Error if no URL can be determined
 */
export function getSlackRedirectBaseUrl(requestUrl?: string): string {
  const { SLACK_REDIRECT_BASE_URL } = env();

  if (SLACK_REDIRECT_BASE_URL) {
    return SLACK_REDIRECT_BASE_URL;
  }

  if (requestUrl) {
    const url = new URL(requestUrl);
    return `${url.protocol}//${url.host}`;
  }

  throw new Error(
    "SLACK_REDIRECT_BASE_URL environment variable is required for Slack integration",
  );
}

// Signature verification
export { verifySlackSignature, getSlackSignatureHeaders } from "./verify";

// Slack API client
export {
  createSlackClient,
  postMessage,
  openModal,
  updateModal,
  publishAppHome,
  exchangeOAuthCode,
  isSlackInvalidAuthError,
} from "./client";

// Block Kit builders
export {
  buildAgentAddModal,
  buildAgentListMessage,
  buildAppHomeView,
  buildErrorMessage,
  buildLoginPromptMessage,
  buildHelpMessage,
  buildWelcomeMessage,
  buildSuccessMessage,
  buildMarkdownMessage,
  buildAgentResponseMessage,
} from "./blocks";

// Thread context
export {
  fetchThreadContext,
  fetchChannelContext,
  formatContextForAgent,
  formatContextForAgentWithImages,
  extractMessageContent,
  parseExplicitAgentSelection,
} from "./context";

// Handlers
export { handleDirectMessage } from "./handlers/direct-message";
export {
  handleAppHomeOpened,
  handleMessagesTabOpened,
  refreshAppHome,
} from "./handlers/app-home-opened";
