// Slack integration utilities

import { eq, and } from "drizzle-orm";
import { env } from "../../env";
import { agentComposes } from "../../db/schema/agent-compose";
import { scopes } from "../../db/schema/scope";

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

/**
 * Resolve the default agent compose ID from SLACK_DEFAULT_AGENT env var.
 * Format: "scope-slug/agent-name" (e.g. "yuma/deep-dive")
 *
 * Returns the compose ID if found, or null.
 */
export async function resolveDefaultAgentComposeId(): Promise<string | null> {
  const { SLACK_DEFAULT_AGENT } = env();
  if (!SLACK_DEFAULT_AGENT) return null;

  const [scopeSlug, agentName] = SLACK_DEFAULT_AGENT.split("/");
  if (!scopeSlug || !agentName) return null;

  const [scope] = await globalThis.services.db
    .select({ id: scopes.id })
    .from(scopes)
    .where(eq(scopes.slug, scopeSlug))
    .limit(1);

  if (!scope) return null;

  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, scope.id),
        eq(agentComposes.name, agentName),
      ),
    )
    .limit(1);

  return compose?.id ?? null;
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
  buildAppHomeView,
  buildErrorMessage,
  buildLoginPromptMessage,
  buildWelcomeMessage,
  buildHelpMessage,
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
} from "./context";

// Handlers
export { handleDirectMessage } from "./handlers/direct-message";
export {
  handleAppHomeOpened,
  handleMessagesTabOpened,
  refreshAppHome,
} from "./handlers/app-home-opened";
