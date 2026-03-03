import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { githubInstallations } from "../../../db/schema/github-installation";
import { githubIssueSessions } from "../../../db/schema/github-issue-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../db/schema/agent-compose";
import { createRun } from "../../run";
import { isConcurrentRunLimit } from "../../errors";
import { generateCallbackSecret, getApiUrl } from "../../callback";
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
  const { action, issue, label, repository, installation } = payload;

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
    issueNumber: issue.number,
    prompt,
    appSlug,
  });
}

/**
 * Handle `issue_comment` events (created).
 *
 * Triggers agent when:
 * - Issue has vm0-agent label, OR
 * - Comment mentions @{app-slug}[bot]
 *
 * Skips if:
 * - Comment is from a bot (prevents self-triggering)
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

  // Check trigger conditions
  const hasLabel = issue.labels.some((l) => l.name === VM0_AGENT_LABEL);
  const botMention = appSlug ? `@${appSlug}[bot]` : null;
  const hasMention = botMention ? comment.body.includes(botMention) : false;

  if (!hasLabel && !hasMention) {
    log.debug("Ignoring comment: no vm0-agent label and no bot mention");
    return;
  }

  // Build prompt with comment as the user message and issue as context
  const prompt = buildCommentPrompt(issue, comment);

  await dispatchAgentRun({
    ghInstallationId: String(installation.id),
    repo: repository.full_name,
    issueNumber: issue.number,
    prompt,
    commentId: String(comment.id),
    appSlug,
  });
}

// ─── Internal Helpers ──────────────────────────────────────────────

interface DispatchParams {
  ghInstallationId: string;
  repo: string;
  issueNumber: number;
  prompt: string;
  commentId?: string;
  appSlug: string | undefined;
}

/**
 * Core dispatch logic shared by issue and comment handlers.
 *
 * 1. Resolve installation from GitHub installation ID
 * 2. Get agent compose and latest version
 * 3. Look up existing session for multi-turn
 * 4. Create agent run with callback
 * 5. Update/create issue session mapping
 */
async function dispatchAgentRun(params: DispatchParams): Promise<void> {
  const { ghInstallationId, repo, issueNumber, prompt, commentId } = params;

  // 1. Resolve installation
  const [installation] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, ghInstallationId))
    .limit(1);

  if (!installation) {
    throw new Error(
      `GitHub installation not found: installationId=${ghInstallationId}`,
    );
  }

  // 2. Resolve agent compose and version
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

  // 3. Look up existing session for multi-turn
  let existingSessionId: string | undefined;
  const [existingSession] = await globalThis.services.db
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

  if (existingSession) {
    existingSessionId = existingSession.agentSessionId;

    // Deduplicate: skip if we already processed this comment
    if (commentId && existingSession.lastCommentId === commentId) {
      log.debug("Skipping duplicate comment", { commentId });
      return;
    }
  }

  // 4. Create agent run with callback
  const callbackUrl = `${getApiUrl()}/api/internal/callbacks/github`;
  const callbackSecret = generateCallbackSecret();
  const callbackContext: GitHubCallbackContext = {
    installationId: installation.id,
    repo,
    issueNumber,
    userId: installation.userId,
    agentName: compose.name,
    composeId: compose.id,
    existingSessionId,
  };

  try {
    const result = await createRun({
      userId: installation.userId,
      agentComposeVersionId: versionId,
      prompt,
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

    // 5. Update or create issue session mapping
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
    if (isConcurrentRunLimit(error)) {
      log.warn("Concurrent run limit reached for GitHub issue", {
        repo,
        issueNumber,
      });
      return;
    }
    throw error;
  }
}

/**
 * Build a prompt from an issue (for opened/labeled events).
 */
function buildIssuePrompt(issue: GitHubIssue): string {
  const parts: string[] = [
    `# GitHub Issue #${issue.number}: ${issue.title}`,
    "",
  ];

  if (issue.body) {
    parts.push(issue.body);
  } else {
    parts.push("(No description provided)");
  }

  return parts.join("\n");
}

/**
 * Build a prompt from a comment, with issue context.
 */
function buildCommentPrompt(
  issue: GitHubIssue,
  comment: GitHubComment,
): string {
  const parts: string[] = [
    `# GitHub Issue #${issue.number}: ${issue.title}`,
    "",
  ];

  if (issue.body) {
    parts.push("## Issue Description", "", issue.body, "");
  }

  parts.push("## New Comment", "", `**@${comment.user.login}:**`, comment.body);

  return parts.join("\n");
}
