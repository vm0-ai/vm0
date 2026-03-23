import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { githubInstallations } from "../../../../../../src/db/schema/github-installation";
import { githubIssueSessions } from "../../../../../../src/db/schema/github-issue-session";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { getInstallationAccessToken } from "../../../../../../src/lib/github/github-app";
import {
  postIssueComment,
  removeCommentReaction,
} from "../../../../../../src/lib/github/api";
import {
  extractRunOutput,
  buildDeepLinksFromFlags,
} from "../../../../../../src/lib/run/extract-run-output";
import { getAppUrl } from "../../../../../../src/lib/url";
import { env } from "../../../../../../src/env";
import type { GitHubIssuesCallbackPayload } from "../../../../../../src/lib/callback/callback-payloads";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:github-issues");

function parsePayload(payload: unknown): GitHubIssuesCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.installationId !== "string" ||
    typeof p.repo !== "string" ||
    typeof p.issueNumber !== "number" ||
    typeof p.composeId !== "string" ||
    typeof p.agentName !== "string"
  ) {
    return null;
  }
  return p as unknown as GitHubIssuesCallbackPayload;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function findNewSessionId(
  userId: string,
  composeId: string,
  runCreatedAt: Date,
): Promise<string | undefined> {
  const [newSession] = await globalThis.services.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, composeId),
        gte(agentSessions.updatedAt, runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return newSession?.id;
}

/**
 * Format agent output as a GitHub issue comment.
 * Mirrors Slack's block layout: agent name header, content, deep links, logs footer.
 */
function formatGitHubComment(opts: {
  status: "completed" | "failed";
  agentName: string;
  runId: string;
  output?: string;
  error?: string;
  triggerCommentBody?: string;
  deepLinks: Array<{ emoji: string; label: string; url: string }>;
}): string {
  const {
    status,
    agentName,
    runId,
    output,
    error,
    triggerCommentBody,
    deepLinks,
  } = opts;
  const appUrl = getAppUrl();
  const logsUrl = `${appUrl}/activity/${encodeURIComponent(runId)}`;
  const content =
    status === "completed"
      ? (output ?? "Task completed successfully.")
      : `**Error:** ${error ?? "Agent execution failed."}`;

  const parts: string[] = [];

  // Quote the triggering comment when replying to an @mention
  if (triggerCommentBody) {
    const quoted = triggerCommentBody
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    parts.push(quoted, "");
  }

  parts.push(`<sub>🤖 **${agentName}**</sub>`, "", content, "");
  if (deepLinks.length > 0) {
    const linkText = deepLinks
      .map((link) => `${link.emoji} [${link.label}](${link.url})`)
      .join(" · ");
    parts.push(`<sub>${linkText}</sub>`, "");
  }

  parts.push(`<sub>📋 [Audit](${logsUrl})</sub>`);

  return parts.join("\n");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<GitHubIssuesCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { installationId, repo, issueNumber, composeId, existingSessionId } =
    payload;

  log.debug("Processing GitHub issues callback", {
    runId,
    status,
    repo,
    issueNumber,
  });

  // Progress notifications are not applicable for GitHub issues — no-op.
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = env();

  // Get GitHub installation for access token
  const [installation] = await globalThis.services.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationId))
    .limit(1);

  if (!installation) {
    log.error("GitHub installation not found", { installationId });
    return errorResponse("GitHub installation not found", 404);
  }

  if (!installation.installationId) {
    log.error("GitHub installation is pending, cannot post comment", {
      installationId,
    });
    return errorResponse("GitHub installation is pending approval", 400);
  }

  // Get a fresh installation access token
  if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    log.error("GitHub App credentials not configured");
    return errorResponse("GitHub App not configured", 500);
  }

  const { token } = await getInstallationAccessToken(
    GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY,
    installation.installationId,
  );

  // Query Axiom for the agent's output
  const resultData = await extractRunOutput(runId, error);

  // Build deep links from structured flags
  const deepLinks = buildDeepLinksFromFlags(
    resultData,
    getAppUrl(),
    payload.agentName,
  );

  // Format and post comment to GitHub issue
  const commentBody = formatGitHubComment({
    status,
    agentName: payload.agentName,
    runId,
    output: resultData.result ?? undefined,
    error,
    triggerCommentBody: payload.triggerCommentBody,
    deepLinks,
  });
  const commentId = await postIssueComment(
    token,
    repo,
    issueNumber,
    commentBody,
  );

  // Remove 👀 reaction now that the agent has responded
  if (payload.triggerCommentId && payload.triggerReactionId) {
    await removeCommentReaction(
      token,
      repo,
      payload.triggerCommentId,
      payload.triggerReactionId,
    );
  }

  // Get run to find userId for session lookup
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  // Save issue session mapping
  if (run) {
    const newSessionId = !existingSessionId
      ? await findNewSessionId(run.userId, composeId, run.createdAt)
      : undefined;

    if (!existingSessionId && newSessionId) {
      // New issue thread — create mapping
      await globalThis.services.db
        .insert(githubIssueSessions)
        .values({
          userId: run.userId,
          installationId,
          repo,
          issueNumber,
          agentSessionId: newSessionId,
          lastCommentId: commentId,
        })
        .onConflictDoNothing();
    } else if (existingSessionId && status === "completed" && commentId) {
      // Existing issue thread — update lastCommentId
      await globalThis.services.db
        .update(githubIssueSessions)
        .set({
          lastCommentId: commentId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(githubIssueSessions.installationId, installationId),
            eq(githubIssueSessions.repo, repo),
            eq(githubIssueSessions.issueNumber, issueNumber),
          ),
        );
    }
  }

  log.debug("GitHub issues callback processed successfully", {
    runId,
    commentId,
  });

  return NextResponse.json({ success: true });
}
