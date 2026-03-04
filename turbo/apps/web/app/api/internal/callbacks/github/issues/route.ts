import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { githubInstallations } from "../../../../../../src/db/schema/github-installation";
import { githubIssueSessions } from "../../../../../../src/db/schema/github-issue-session";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { getInstallationAccessToken } from "../../../../../../src/lib/github/github-app";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:github-issues");

interface CallbackPayload {
  installationId: string; // GitHub App installation ID (DB primary key)
  repo: string; // "owner/repo"
  issueNumber: number;
  composeId: string;
  existingSessionId?: string;
}

function parsePayload(payload: unknown): CallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.installationId !== "string" ||
    typeof p.repo !== "string" ||
    typeof p.issueNumber !== "number" ||
    typeof p.composeId !== "string"
  ) {
    return null;
  }
  return p as unknown as CallbackPayload;
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
 * Format agent output as a GitHub issue comment with attribution footer.
 */
function formatGitHubComment(
  output: string,
  status: "completed" | "failed",
  error?: string,
): string {
  const body =
    status === "completed"
      ? output || "Task completed successfully."
      : `**Error:** ${error ?? "Agent execution failed."}`;

  return `${body}\n\n---\n*🤖 Powered by [VM0](https://vm0.com)*`;
}

/**
 * Post a comment to a GitHub issue using the installation access token.
 */
async function postIssueComment(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<string | undefined> {
  const res = await fetch(
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post GitHub comment: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id: number };
  return String(data.id);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<CallbackPayload>(request, log);
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
  const output = status === "completed" ? await getRunOutput(runId) : undefined;

  // Format and post comment to GitHub issue
  const commentBody = formatGitHubComment(output ?? "", status, error);
  const commentId = await postIssueComment(
    token,
    repo,
    issueNumber,
    commentBody,
  );

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
