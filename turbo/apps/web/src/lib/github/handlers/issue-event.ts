import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { githubInstallations } from "../../../db/schema/github-installation";
import { githubUserLinks } from "../../../db/schema/github-user-link";
import { githubIssueSessions } from "../../../db/schema/github-issue-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { createRun, validateAgentSession } from "../../run";
import { isConcurrentRunLimit } from "../../errors";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { getInstallationAccessToken } from "../github-app";
import { env } from "../../../env";
import { logger } from "../../logger";

const log = logger("github:issue-event");

const VM0_AGENT_LABEL = "vm0-agent";

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

// ─── Callback Context ──────────────────────────────────────────────

interface GitHubCallbackContext {
  installationId: string;
  repo: string;
  issueNumber: number;
  userId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
  triggerCommentId?: string;
  triggerCommentBody?: string;
  triggerReactionId?: string;
}

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

  // For "labeled" action, only trigger when the vm0-agent label is added
  if (action === "labeled" && label?.name !== VM0_AGENT_LABEL) {
    log.debug("Ignoring label that is not vm0-agent", { label: label?.name });
    return;
  }

  // For "opened" action, check if issue has the vm0-agent label
  if (action === "opened") {
    const hasLabel = issue.labels.some((l) => l.name === VM0_AGENT_LABEL);
    if (!hasLabel) {
      log.debug("Ignoring opened issue without vm0-agent label");
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
  const prompt = buildCommentPrompt(issue, comment);

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
 * Core dispatch logic shared by issue and comment handlers.
 *
 * 1. Resolve installation from GitHub installation ID
 * 2. Resolve VM0 user via github_user_links
 * 3. Get agent compose and latest version
 * 4. Look up existing session for multi-turn
 * 5. Create agent run with callback
 * 6. Update/create issue session mapping
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

  // 1. Resolve installation (only active installations can trigger runs)
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

  // Add 👀 reaction to the triggering comment
  let reactionId: string | undefined;
  if (token && commentId) {
    reactionId = await addCommentReaction(token, repo, commentId, "eyes");
  }

  // 2. Resolve VM0 user via github_user_links
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
    // TODO: Post comment asking user to link their VM0 account
    return;
  }

  const vm0UserId = userLink.vm0UserId;

  // 3. Resolve agent compose and version
  const [compose] = await globalThis.services.db
    .select()
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  if (!compose) {
    throw new Error(
      `Agent compose not found: composeId=${installation.defaultComposeId}`,
    );
  }

  let versionId = compose.headVersionId;
  if (!versionId) {
    const [latestVersion] = await globalThis.services.db
      .select({ id: agentComposeVersions.id })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.composeId, compose.id))
      .orderBy(desc(agentComposeVersions.createdAt))
      .limit(1);

    if (!latestVersion) {
      throw new Error(`Agent compose has no versions: composeId=${compose.id}`);
    }
    versionId = latestVersion.id;
  }

  // 4. Look up existing session for multi-turn (skip for label triggers — always new session)
  let existingSessionId: string | undefined;
  let existingSession:
    | { agentSessionId: string; lastCommentId: string | null }
    | undefined;

  if (!params.forceNewSession) {
    const [found] = await globalThis.services.db
      .select({
        agentSessionId: githubIssueSessions.agentSessionId,
        lastCommentId: githubIssueSessions.lastCommentId,
      })
      .from(githubIssueSessions)
      .where(
        and(
          eq(githubIssueSessions.installationId, installation.id),
          eq(githubIssueSessions.repo, repo),
          eq(githubIssueSessions.issueNumber, issueNumber),
        ),
      )
      .limit(1);
    existingSession = found;

    if (existingSession) {
      // Deduplicate: skip if we already processed this comment
      if (commentId && existingSession.lastCommentId === commentId) {
        log.debug("Skipping duplicate comment", { commentId });
        return;
      }

      // Validate session's agent matches current default — discard if changed
      try {
        const sessionData = await validateAgentSession(
          existingSession.agentSessionId,
          vm0UserId,
        );
        if (sessionData.agentComposeId === compose.id) {
          existingSessionId = existingSession.agentSessionId;
        } else {
          log.debug("Agent changed, starting new session", {
            sessionComposeId: sessionData.agentComposeId,
            currentComposeId: compose.id,
          });
        }
      } catch {
        log.debug("Session validation failed, starting new session");
      }
    }
  }

  // 5. Fetch issue context (comments history)
  const lastCommentId = existingSessionId
    ? (existingSession?.lastCommentId ?? undefined)
    : undefined;
  let issueContext = "";
  if (token) {
    const comments = await fetchIssueComments(token, repo, issueNumber);
    issueContext = formatIssueContext(
      issue,
      comments,
      lastCommentId,
      commentId,
    );
  }

  // Build full prompt with context
  let fullPrompt: string;
  if (issueContext) {
    if (commentId) {
      // Comment trigger — context + comment body as user prompt
      fullPrompt = `${issueContext}\n\n# User Prompt\n\n${prompt}`;
    } else {
      // Label trigger — context already includes issue body and comments.
      // Instruct the agent to analyze the context and decide what to do.
      fullPrompt = `${issueContext}\n\nBased on the GitHub issue above and its discussion, analyze the request and decide on the appropriate action.`;
    }
  } else {
    fullPrompt = prompt;
  }

  // 6. Create agent run with callback
  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/github/issues`;
  const callbackSecret = generateCallbackSecret();
  const callbackContext: GitHubCallbackContext = {
    installationId: installation.id,
    repo,
    issueNumber,
    userId: vm0UserId,
    agentName: compose.name,
    composeId: compose.id,
    existingSessionId,
    triggerCommentId: commentId,
    triggerCommentBody: commentId ? params.comment?.body : undefined,
    triggerReactionId: reactionId,
  };

  try {
    const result = await createRun({
      userId: vm0UserId,
      agentComposeVersionId: versionId,
      prompt: fullPrompt,
      composeId: compose.id,
      sessionId: existingSessionId,
      agentName: compose.name,
      artifactName: "artifact",
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

    // 6. Update or create issue session mapping
    if (existingSession) {
      // Update lastCommentId for deduplication
      if (commentId) {
        await globalThis.services.db
          .update(githubIssueSessions)
          .set({
            lastCommentId: commentId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(githubIssueSessions.installationId, installation.id),
              eq(githubIssueSessions.repo, repo),
              eq(githubIssueSessions.issueNumber, issueNumber),
            ),
          );
      }
    }
    // Note: New session mapping will be created by the callback handler
    // once the run completes and we have the agentSessionId from the result
  } catch (error) {
    // Remove 👀 reaction on failure
    if (token && commentId && reactionId) {
      await removeCommentReaction(token, repo, commentId, reactionId);
    }

    const commentBody = params.comment?.body;
    const quotePrefix = commentBody
      ? commentBody
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n\n"
      : "";

    if (isConcurrentRunLimit(error)) {
      log.warn("Concurrent run limit reached for GitHub issue", {
        repo,
        issueNumber,
      });
      if (token) {
        await postIssueComment(
          token,
          repo,
          issueNumber,
          `${quotePrefix}⚠️ The agent is currently busy with another task. Please try again shortly.`,
        );
      }
      return;
    }

    if (token) {
      const message =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";
      await postIssueComment(
        token,
        repo,
        issueNumber,
        `${quotePrefix}❌ Failed to start the agent: ${message}`,
      );
    }
    throw error;
  }
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
function buildCommentPrompt(
  _issue: GitHubIssue,
  comment: GitHubComment,
): string {
  return comment.body;
}

// ─── Issue Context ──────────────────────────────────────────────────

interface IssueComment {
  id: number;
  user: { login: string; type: string };
  body: string;
  created_at: string;
}

/**
 * Fetch issue comments from GitHub API.
 * Returns up to 100 most recent comments.
 */
async function fetchIssueComments(
  token: string,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=100&direction=asc`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    log.warn("Failed to fetch issue comments", {
      status: res.status,
      repo,
      issueNumber,
    });
    return [];
  }

  return (await res.json()) as IssueComment[];
}

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
    ? comments.filter((c) => c.id > Number(lastCommentId))
    : comments;
  if (currentCommentId) {
    relevantComments = relevantComments.filter(
      (c) => String(c.id) !== currentCommentId,
    );
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

// ─── GitHub API Helpers ─────────────────────────────────────────────

async function addCommentReaction(
  token: string,
  repo: string,
  commentId: string,
  content: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ content }),
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { id: number };
    return String(data.id);
  } catch {
    return undefined;
  }
}

async function removeCommentReaction(
  token: string,
  repo: string,
  commentId: string,
  reactionId: string,
): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
  } catch {
    // Best-effort
  }
}

async function postIssueComment(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  try {
    await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
      },
    );
  } catch {
    // Best-effort
  }
}
