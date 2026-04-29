import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/infra/callback";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { getInstallationAccessToken } from "../../../../../../src/lib/zero/github/github-app";
import {
  postIssueComment,
  removeCommentReaction,
} from "../../../../../../src/lib/zero/github/api";
import { extractRunOutput } from "../../../../../../src/lib/infra/run/extract-run-output";
import { getAppUrl } from "../../../../../../src/lib/zero/url";
import { loadFeatureSwitchOverrides } from "../../../../../../src/lib/zero/user/feature-switches-service";
import { env } from "../../../../../../src/env";
import type { GitHubIssuesCallbackPayload } from "../../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("callback:github-issues");

function parsePayload(payload: unknown): GitHubIssuesCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.installationId !== "string" ||
    typeof p.repo !== "string" ||
    typeof p.issueNumber !== "number" ||
    typeof p.agentId !== "string"
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
  agentId: string,
  runCreatedAt: Date,
): Promise<string | undefined> {
  const [newSession] = await globalThis.services.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentId),
        gte(agentSessions.updatedAt, runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return newSession?.id;
}

async function resolveAgentInfo(agentId: string) {
  const [agentRow] = await globalThis.services.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return {
    label: agentRow?.displayName ?? agentRow?.name ?? "your agent",
    name: agentRow?.name ?? "your agent",
  };
}

async function saveIssueSession(opts: {
  runId: string;
  agentId: string;
  installationId: string;
  repo: string;
  issueNumber: number;
  existingSessionId: string | undefined;
  commentId: string;
  status: string;
}) {
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, opts.runId))
    .limit(1);

  if (!run) return;

  const newSessionId = !opts.existingSessionId
    ? await findNewSessionId(run.userId, opts.agentId, run.createdAt)
    : undefined;

  if (!opts.existingSessionId && newSessionId) {
    await globalThis.services.db
      .insert(githubIssueSessions)
      .values({
        userId: run.userId,
        installationId: opts.installationId,
        repo: opts.repo,
        issueNumber: opts.issueNumber,
        agentSessionId: newSessionId,
        lastCommentId: opts.commentId,
      })
      .onConflictDoNothing();
  } else if (
    opts.existingSessionId &&
    opts.status === "completed" &&
    opts.commentId
  ) {
    await globalThis.services.db
      .update(githubIssueSessions)
      .set({
        lastCommentId: opts.commentId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(githubIssueSessions.installationId, opts.installationId),
          eq(githubIssueSessions.repo, opts.repo),
          eq(githubIssueSessions.issueNumber, opts.issueNumber),
        ),
      );
  }
}

/**
 * Format agent output as a GitHub issue comment.
 * Mirrors Slack's block layout: agent name header, content, deep links, logs footer.
 */
function formatGitHubComment(opts: {
  status: "completed" | "failed";
  agentName: string;
  logsUrl?: string;
  output?: string;
  error?: string;
  triggerCommentBody?: string;
}): string {
  const { status, agentName, logsUrl, output, error, triggerCommentBody } =
    opts;
  const content =
    status === "completed"
      ? (output ?? "Task completed successfully.")
      : `**Error:** ${error ?? "Agent execution failed."}`;

  const parts: string[] = [];

  // Quote the triggering comment when replying to an @mention
  if (triggerCommentBody) {
    const quoted = triggerCommentBody
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    parts.push(quoted, "");
  }

  parts.push(`<sub>🤖 **${agentName}**</sub>`, "", content);
  if (logsUrl) {
    parts.push("");
    parts.push(`<sub>📋 [Audit](${logsUrl})</sub>`);
  }

  return parts.join("\n");
}

async function resolveGitHubAuditLogsUrl(
  runId: string,
): Promise<string | undefined> {
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run) {
    return undefined;
  }

  const overrides = await loadFeatureSwitchOverrides(run.orgId, run.userId);
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: run.userId,
    orgId: run.orgId,
    overrides,
  });
  if (!enabled) {
    return undefined;
  }

  return `${getAppUrl()}/activities/${encodeURIComponent(runId)}`;
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

  const { installationId, repo, issueNumber, agentId, existingSessionId } =
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

  const agent = await resolveAgentInfo(agentId);

  // Query Axiom for the agent's output
  const resultData = await extractRunOutput(runId, error);

  // Format and post comment to GitHub issue
  const commentBody = formatGitHubComment({
    status,
    agentName: agent.label,
    logsUrl: await resolveGitHubAuditLogsUrl(runId),
    output: resultData.result ?? undefined,
    error,
    triggerCommentBody: payload.triggerCommentBody,
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

  // Save issue session mapping
  await saveIssueSession({
    runId,
    agentId,
    installationId,
    repo,
    issueNumber,
    existingSessionId,
    commentId,
    status,
  });

  log.debug("GitHub issues callback processed successfully", {
    runId,
    commentId,
  });

  return NextResponse.json({ success: true });
}
