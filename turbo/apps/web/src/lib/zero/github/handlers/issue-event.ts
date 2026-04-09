import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { githubInstallations } from "../../../../db/schema/github-installation";
import { githubUserLinks } from "../../../../db/schema/github-user-link";
import { githubIssueSessions } from "../../../../db/schema/github-issue-session";
import { agentComposes } from "../../../../db/schema/agent-compose";
import { validateAgentSession } from "../../zero-run-validation";
import { createZeroRun } from "../../zero-run-service";
import { buildGitHubPrompt } from "../../integration-prompt";
import { resolveAgentId } from "../../zero-compose-service";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import type { GitHubIssuesCallbackPayload } from "../../../infra/callback/callback-payloads";
import { getInstallationAccessToken } from "../github-app";
import {
  type IssueComment,
  addCommentReaction,
  fetchIssueComments,
  postIssueCommentBestEffort,
  removeCommentReaction,
} from "../api";
import { env } from "../../../../env";
import { logger } from "../../../shared/logger";

const log = logger("github:issue-event");

// ─── GitHub Webhook Payload Schemas ────────────────────────────────

const gitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const gitHubLabelSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const gitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  labels: z.array(gitHubLabelSchema),
  user: gitHubUserSchema,
});

const gitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: gitHubUserSchema,
});

const gitHubRepositorySchema = z.object({
  full_name: z.string(),
});

const gitHubInstallationSchema = z.object({
  id: z.number(),
});

export const gitHubIssuesEventSchema = z.object({
  action: z.string(),
  issue: gitHubIssueSchema,
  label: gitHubLabelSchema.optional(),
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationSchema,
  sender: gitHubUserSchema,
});

export const gitHubIssueCommentEventSchema = z.object({
  action: z.string(),
  issue: gitHubIssueSchema,
  comment: gitHubCommentSchema,
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationSchema,
  sender: gitHubUserSchema,
});

// ─── GitHub Webhook Payload Types ──────────────────────────────────

type GitHubIssuesEvent = z.infer<typeof gitHubIssuesEventSchema>;
type GitHubIssueCommentEvent = z.infer<typeof gitHubIssueCommentEventSchema>;
type GitHubIssue = z.infer<typeof gitHubIssueSchema>;
type GitHubComment = z.infer<typeof gitHubCommentSchema>;

// ─── Event Handlers ────────────────────────────────────────────────

/**
 * Handle `issues` events (opened, labeled).
 *
 * Triggers agent when:
 * - issues.opened with vm0-agent label
 * - issues.labeled with vm0-agent label
 */
export async function handleIssuesEvent(
  payload: GitHubIssuesEvent,
  appSlug: string | undefined,
): Promise<void> {
  const { action, issue, label, repository, installation, sender } = payload;

  // Only handle opened and labeled actions
  if (action !== "opened" && action !== "labeled") {
    log.debug("Ignoring issues event", { action });
    return;
  }

  if (!appSlug) {
    log.debug("Ignoring issues event: app slug not configured");
    return;
  }

  // For "labeled" action, only trigger when the app slug label is added
  if (action === "labeled" && label?.name !== appSlug) {
    log.debug("Ignoring label that is not app slug", {
      label: label?.name,
      expected: appSlug,
    });
    return;
  }

  // For "opened" action, check if issue has the app slug label
  if (action === "opened") {
    const hasLabel = issue.labels.some((l) => {
      return l.name === appSlug;
    });
    if (!hasLabel) {
      log.debug("Ignoring opened issue without app slug label", {
        expected: appSlug,
      });
      return;
    }
  }

  // Build prompt from issue content
  const prompt = buildIssuePrompt(issue);

  await dispatchAgentRun({
    ghInstallationId: String(installation.id),
    repo: repository.full_name,
    issue,
    senderGithubUserId: String(sender.id),
    prompt,
    forceNewSession: true,
    appSlug,
  });
}

/**
 * Handle `issue_comment` events (created).
 *
 * Triggers agent when:
 * - Comment mentions @{app-slug}[bot]
 *
 * Skips if:
 * - Comment is from a bot (prevents self-triggering)
 * - App slug is not configured
 */
export async function handleIssueCommentEvent(
  payload: GitHubIssueCommentEvent,
  appSlug: string | undefined,
): Promise<void> {
  const { action, issue, comment, repository, installation, sender } = payload;

  if (action !== "created") {
    log.debug("Ignoring issue_comment event", { action });
    return;
  }

  // Prevent self-triggering: ignore comments from bots
  if (sender.type === "Bot") {
    log.debug("Ignoring comment from bot", { sender: sender.login });
    return;
  }

  // Only trigger when the comment explicitly mentions the bot
  if (!appSlug) {
    log.debug("Ignoring comment: app slug not configured");
    return;
  }

  const botMention = `@${appSlug}[bot]`;
  if (!comment.body.includes(botMention)) {
    log.debug("Ignoring comment: no bot mention", { expected: botMention });
    return;
  }

  // Build prompt with comment as the user message and issue as context
  const prompt = buildCommentPrompt(comment);

  await dispatchAgentRun({
    ghInstallationId: String(installation.id),
    repo: repository.full_name,
    issue,
    senderGithubUserId: String(sender.id),
    prompt,
    commentId: String(comment.id),
    comment,
    appSlug,
  });
}

// ─── Internal Helpers ──────────────────────────────────────────────

interface DispatchParams {
  ghInstallationId: string;
  repo: string;
  issue: GitHubIssue;
  senderGithubUserId: string;
  prompt: string;
  commentId?: string;
  comment?: GitHubComment;
  forceNewSession?: boolean;
  appSlug: string | undefined;
}

/**
 * Look up and validate an existing issue session for multi-turn.
 * Returns the validated session ID, or undefined to start a new session.
 * Returns "duplicate" if the comment was already processed.
 */
async function resolveExistingSession(
  installationDbId: string,
  repo: string,
  issueNumber: number,
  composeId: string,
  vm0UserId: string,
  commentId: string | undefined,
): Promise<
  | { kind: "duplicate" }
  | {
      kind: "resolved";
      sessionId: string | undefined;
      lastCommentId: string | null | undefined;
    }
> {
  const [found] = await globalThis.services.db
    .select({
      agentSessionId: githubIssueSessions.agentSessionId,
      lastCommentId: githubIssueSessions.lastCommentId,
    })
    .from(githubIssueSessions)
    .where(
      and(
        eq(githubIssueSessions.installationId, installationDbId),
        eq(githubIssueSessions.repo, repo),
        eq(githubIssueSessions.issueNumber, issueNumber),
      ),
    )
    .limit(1);

  if (!found) {
    return { kind: "resolved", sessionId: undefined, lastCommentId: undefined };
  }

  // Deduplicate: skip if we already processed this comment
  if (commentId && found.lastCommentId === commentId) {
    log.debug("Skipping duplicate comment", { commentId });
    return { kind: "duplicate" };
  }

  // Validate session's agent matches current default
  const sessionId = await validateSessionAgent(
    found.agentSessionId,
    vm0UserId,
    composeId,
  );
  return {
    kind: "resolved",
    sessionId,
    lastCommentId: sessionId ? found.lastCommentId : undefined,
  };
}

/**
 * Validate that a session's agent matches the expected compose.
 * Returns the session ID if valid, undefined otherwise.
 */
async function validateSessionAgent(
  sessionId: string,
  vm0UserId: string,
  expectedComposeId: string,
): Promise<string | undefined> {
  try {
    const sessionData = await validateAgentSession(sessionId, vm0UserId);
    if (sessionData.agentComposeId === expectedComposeId) {
      return sessionId;
    }
    log.debug("Agent changed, starting new session", {
      sessionComposeId: sessionData.agentComposeId,
      currentComposeId: expectedComposeId,
    });
    return undefined;
  } catch (error) {
    log.warn("Session validation failed, starting new session", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Build prompt and system context from issue context.
 * Integration context and issue context go to appendSystemPrompt;
 * only the user message remains in prompt.
 */
function buildPromptParts(
  prompt: string,
  issueContext: string,
  isCommentTrigger: boolean,
): { prompt: string; appendSystemPrompt: string | undefined } {
  const appendSystemPrompt = buildGitHubPrompt(issueContext) || undefined;

  const userPrompt = isCommentTrigger
    ? prompt
    : issueContext
      ? "Based on the GitHub issue above and its discussion, analyze the request and decide on the appropriate action."
      : prompt;

  return { prompt: userPrompt, appendSystemPrompt };
}

/**
 * Handle error from createRun: remove reaction and post error feedback.
 */
async function handleDispatchError(
  error: unknown,
  token: string | undefined,
  repo: string,
  issueNumber: number,
  commentId: string | undefined,
  reactionId: string | undefined,
  commentBody: string | undefined,
): Promise<void> {
  if (token && commentId && reactionId) {
    await removeCommentReaction(token, repo, commentId, reactionId);
  }

  const quotePrefix = commentBody
    ? commentBody
        .split("\n")
        .map((line) => {
          return `> ${line}`;
        })
        .join("\n") + "\n\n"
    : "";

  if (token) {
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred.";
    await postIssueCommentBestEffort(
      token,
      repo,
      issueNumber,
      `${quotePrefix}❌ Failed to start the agent: ${message}`,
    );
  }
  throw error;
}

/**
 * Core dispatch logic shared by issue and comment handlers.
 */
async function dispatchAgentRun(params: DispatchParams): Promise<void> {
  const {
    ghInstallationId,
    repo,
    issue,
    senderGithubUserId,
    prompt,
    commentId,
  } = params;
  const issueNumber = issue.number;

  // 1. Resolve installation
  const [installation] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, ghInstallationId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);

  if (!installation) {
    throw new Error(
      `GitHub installation not found: installationId=${ghInstallationId}`,
    );
  }

  // Get GitHub token early for reactions and error comments
  const token = installation.installationId
    ? await getGitHubToken(installation.installationId)
    : undefined;

  // Add eyes reaction to the triggering comment
  const reactionId =
    token && commentId
      ? await addCommentReaction(token, repo, commentId, "eyes")
      : undefined;

  // 2. Resolve VM0 user
  const [userLink] = await globalThis.services.db
    .select({ vm0UserId: githubUserLinks.vm0UserId })
    .from(githubUserLinks)
    .where(
      and(
        eq(githubUserLinks.githubUserId, senderGithubUserId),
        eq(githubUserLinks.installationId, installation.id),
      ),
    )
    .limit(1);

  if (!userLink) {
    log.warn("No VM0 user linked for GitHub user", {
      githubUserId: senderGithubUserId,
      installationId: installation.id,
    });
    return;
  }

  const vm0UserId = userLink.vm0UserId;

  // 3. Resolve agent compose (version + org resolved by createZeroRun)
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  if (!compose) {
    throw new Error(
      `Agent compose not found: composeId=${installation.defaultComposeId}`,
    );
  }

  // 3b. Resolve agentId from compose
  const agentId = await resolveAgentId(compose.orgId, compose.name);
  if (!agentId) {
    throw new Error(
      `Zero agent not found for compose: composeId=${compose.id}`,
    );
  }

  // 4. Look up existing session
  let existingSessionId: string | undefined;
  let lastCommentId: string | null | undefined;

  if (!params.forceNewSession) {
    const sessionResult = await resolveExistingSession(
      installation.id,
      repo,
      issueNumber,
      compose.id,
      vm0UserId,
      commentId,
    );
    if (sessionResult.kind === "duplicate") return;
    existingSessionId = sessionResult.sessionId;
    lastCommentId = sessionResult.lastCommentId;
  }

  // 5. Fetch issue context and build prompt
  let issueContext = "";
  if (token) {
    const comments = await fetchIssueComments(token, repo, issueNumber);
    issueContext = formatIssueContext(
      issue,
      comments,
      existingSessionId ? (lastCommentId ?? undefined) : undefined,
      commentId,
    );
  }
  const { prompt: resolvedPrompt, appendSystemPrompt } = buildPromptParts(
    prompt,
    issueContext,
    !!commentId,
  );

  // 6. Create agent run with callback
  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/github/issues`;
  const callbackSecret = generateCallbackSecret();
  const callbackContext: GitHubIssuesCallbackPayload = {
    installationId: installation.id,
    repo,
    issueNumber,
    agentId: compose.id,
    existingSessionId,
    triggerCommentId: commentId,
    triggerCommentBody: commentId ? params.comment?.body : undefined,
    triggerReactionId: reactionId,
  };

  try {
    const result = await createZeroRun({
      userId: vm0UserId,
      prompt: resolvedPrompt,
      appendSystemPrompt,
      agentId,
      sessionId: existingSessionId,
      triggerSource: "github",
      callbacks: [
        {
          url: callbackUrl,
          secret: callbackSecret,
          payload: callbackContext,
        },
      ],
    });

    log.info("Agent run dispatched for GitHub issue", {
      runId: result.runId,
      repo,
      issueNumber,
    });

    // Update lastCommentId for deduplication on existing sessions
    if (existingSessionId && commentId) {
      await globalThis.services.db
        .update(githubIssueSessions)
        .set({ lastCommentId: commentId, updatedAt: new Date() })
        .where(
          and(
            eq(githubIssueSessions.installationId, installation.id),
            eq(githubIssueSessions.repo, repo),
            eq(githubIssueSessions.issueNumber, issueNumber),
          ),
        );
    }
  } catch (error) {
    await handleDispatchError(
      error,
      token,
      repo,
      issueNumber,
      commentId,
      reactionId,
      params.comment?.body,
    );
  }
  // Note: New session mapping will be created by the callback handler
  // once the run completes and we have the agentSessionId from the result
}

/**
 * Build a prompt from an issue (for opened/labeled events).
 * Sends only the issue body as the user prompt.
 */
function buildIssuePrompt(issue: GitHubIssue): string {
  return issue.body ?? issue.title;
}

/**
 * Build a prompt from a comment.
 * Sends only the comment body as the user prompt.
 */
function buildCommentPrompt(comment: GitHubComment): string {
  return comment.body;
}

// ─── Issue Context ──────────────────────────────────────────────────

/**
 * Format issue and comments as context for the agent prompt.
 * When lastCommentId is provided, only includes comments after it (dedup for session continuity).
 */
function formatIssueContext(
  issue: GitHubIssue,
  comments: IssueComment[],
  lastCommentId: string | undefined,
  currentCommentId: string | undefined,
): string {
  // Filter to only new comments when continuing a session,
  // and exclude the triggering comment (it's already in the user prompt)
  let relevantComments = lastCommentId
    ? comments.filter((c) => {
        return c.id > Number(lastCommentId);
      })
    : comments;
  if (currentCommentId) {
    relevantComments = relevantComments.filter((c) => {
      return String(c.id) !== currentCommentId;
    });
  }

  if (relevantComments.length === 0 && lastCommentId) {
    // Session continuation with no new comments — no context needed
    return "";
  }

  const parts: string[] = ["# GitHub Issue Context"];

  if (!lastCommentId) {
    // New session — include issue body
    parts.push(
      "",
      `**${issue.title}** (#${issue.number})`,
      "",
      issue.body ?? "_No description provided._",
    );
  }

  if (relevantComments.length > 0) {
    parts.push("", "## Comments", "");
    for (const comment of relevantComments) {
      const role = comment.user.type === "Bot" ? "bot" : "user";
      parts.push(`**@${comment.user.login}** (${role}):`, comment.body, "");
    }
  }

  parts.push("---");
  return parts.join("\n");
}

/**
 * Get a GitHub installation access token, returning undefined if credentials are not configured.
 */
async function getGitHubToken(
  ghInstallationId: string,
): Promise<string | undefined> {
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = env();
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return undefined;
  }
  const { token } = await getInstallationAccessToken(
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    ghInstallationId,
  );
  return token;
}
