import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  githubIssuesCallbackPayloadSchema,
  internalCallbacksGithubIssuesContract,
  type GitHubIssuesCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-github-issues";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq, gte } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { optionalEnv, env } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { getGithubInstallationAccessToken } from "../services/github-app.service";
import {
  postGithubIssueComment,
  removeGithubCommentReaction,
} from "../services/github-issues-api.service";
import { getRunOutputText } from "../services/run-output.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const L = logger("InternalCallbacksGithubIssues");

function successResponse(): {
  readonly status: 200;
  readonly body: { readonly success: true };
} {
  return { status: 200, body: { success: true } };
}

function errorResponse(
  status: 400 | 404 | 500,
  message: string,
): {
  readonly status: 400 | 404 | 500;
  readonly body: { readonly error: string };
} {
  return { status, body: { error: message } };
}

function parsePayload(payload: unknown): GitHubIssuesCallbackPayload | null {
  const result = githubIssuesCallbackPayloadSchema.safeParse(payload);
  return result.success ? result.data : null;
}

async function findNewSessionId(args: {
  readonly db: Db;
  readonly userId: string;
  readonly agentId: string;
  readonly runCreatedAt: Date;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const [newSession] = await args.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, args.userId),
        eq(agentSessions.agentComposeId, args.agentId),
        gte(agentSessions.updatedAt, args.runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  args.signal.throwIfAborted();
  return newSession?.id;
}

async function resolveAgentInfo(args: {
  readonly db: Db;
  readonly agentId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly label: string; readonly name: string }> {
  const [agentRow] = await args.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.agentId))
    .limit(1);
  args.signal.throwIfAborted();

  return {
    label: agentRow?.displayName ?? agentRow?.name ?? "your agent",
    name: agentRow?.name ?? "your agent",
  };
}

async function saveIssueSession(args: {
  readonly db: Db;
  readonly runId: string;
  readonly agentId: string;
  readonly installationId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly existingSessionId: string | undefined;
  readonly commentId: string;
  readonly status: "completed" | "failed";
  readonly signal: AbortSignal;
}): Promise<void> {
  const [run] = await args.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!run) {
    return;
  }

  const newSessionId = !args.existingSessionId
    ? await findNewSessionId({
        db: args.db,
        userId: run.userId,
        agentId: args.agentId,
        runCreatedAt: run.createdAt,
        signal: args.signal,
      })
    : undefined;

  if (!args.existingSessionId && newSessionId) {
    await args.db
      .insert(githubIssueSessions)
      .values({
        userId: run.userId,
        installationId: args.installationId,
        repo: args.repo,
        issueNumber: args.issueNumber,
        agentSessionId: newSessionId,
        lastCommentId: args.commentId,
      })
      .onConflictDoNothing();
    args.signal.throwIfAborted();
  } else if (
    args.existingSessionId &&
    args.status === "completed" &&
    args.commentId
  ) {
    await args.db
      .update(githubIssueSessions)
      .set({
        lastCommentId: args.commentId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(githubIssueSessions.installationId, args.installationId),
          eq(githubIssueSessions.repo, args.repo),
          eq(githubIssueSessions.issueNumber, args.issueNumber),
        ),
      );
    args.signal.throwIfAborted();
  }
}

function formatGitHubComment(args: {
  readonly status: "completed" | "failed";
  readonly agentName: string;
  readonly logsUrl?: string;
  readonly output?: string;
  readonly error?: string;
  readonly triggerCommentBody?: string;
}): string {
  const content =
    args.status === "completed"
      ? (args.output ?? "Task completed successfully.")
      : `**Error:** ${args.error ?? "Agent execution failed."}`;

  const parts: string[] = [];
  if (args.triggerCommentBody) {
    const quoted = args.triggerCommentBody
      .split("\n")
      .map((line) => {
        return `> ${line}`;
      })
      .join("\n");
    parts.push(quoted, "");
  }

  parts.push(`<sub>🤖 **${args.agentName}**</sub>`, "", content);
  if (args.logsUrl) {
    parts.push("", `<sub>📋 [Audit](${args.logsUrl})</sub>`);
  }

  return parts.join("\n");
}

async function resolveGitHubAuditLogsUrl(args: {
  readonly db: Db;
  readonly runId: string;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const [run] = await args.db
    .select({ userId: agentRuns.userId, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!run) {
    return undefined;
  }

  const overrides = await args.getFeatureOverrides(run.orgId, run.userId);
  args.signal.throwIfAborted();
  const typedOverrides =
    Object.keys(overrides).length > 0
      ? (overrides as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: run.userId,
    orgId: run.orgId,
    overrides: typedOverrides,
  });
  if (!enabled) {
    return undefined;
  }

  return `${env("VM0_WEB_URL")}/activities/${encodeURIComponent(args.runId)}`;
}

const handleGithubIssuesCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);
    const payload = parsePayload(callback.payload);
    if (!payload) {
      return errorResponse(400, "Invalid or missing payload");
    }

    const { runId, status, error } = callback;
    const { installationId, repo, issueNumber, agentId, existingSessionId } =
      payload;

    L.debug("Processing GitHub issues callback", {
      runId,
      status,
      repo,
      issueNumber,
    });

    if (status === "progress") {
      return successResponse();
    }

    const db = set(writeDb$);
    const [installation] = await db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, installationId))
      .limit(1);
    signal.throwIfAborted();

    if (!installation) {
      L.error("GitHub installation not found", { installationId });
      return errorResponse(404, "GitHub installation not found");
    }

    if (!installation.installationId) {
      L.error("GitHub installation is pending, cannot post comment", {
        installationId,
      });
      return errorResponse(400, "GitHub installation is pending approval");
    }

    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
    if (!appId || !privateKey) {
      L.error("GitHub App credentials not configured");
      return errorResponse(500, "GitHub App not configured");
    }

    const { token } = await getGithubInstallationAccessToken({
      appId,
      privateKey,
      installationId: installation.installationId,
      signal,
    });
    signal.throwIfAborted();

    const agent = await resolveAgentInfo({ db, agentId, signal });
    const output =
      status === "completed"
        ? await getRunOutputText(runId, { signal })
        : undefined;
    signal.throwIfAborted();

    const logsUrl = await resolveGitHubAuditLogsUrl({
      db,
      runId,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      signal,
    });
    const commentBody = formatGitHubComment({
      status,
      agentName: agent.label,
      logsUrl,
      output,
      error,
      triggerCommentBody: payload.triggerCommentBody,
    });
    const commentId = await postGithubIssueComment({
      token,
      repo,
      issueNumber,
      body: commentBody,
      signal,
    });
    signal.throwIfAborted();

    if (payload.triggerCommentId && payload.triggerReactionId) {
      await removeGithubCommentReaction({
        token,
        repo,
        commentId: payload.triggerCommentId,
        reactionId: payload.triggerReactionId,
        signal,
      });
      signal.throwIfAborted();
    }

    await saveIssueSession({
      db,
      runId,
      agentId,
      installationId,
      repo,
      issueNumber,
      existingSessionId,
      commentId,
      status,
      signal,
    });

    L.debug("GitHub issues callback processed successfully", {
      runId,
      commentId,
    });

    return successResponse();
  },
);

export const internalCallbacksGithubIssuesRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksGithubIssuesContract.post,
    handler: callbackRoute(handleGithubIssuesCallback$),
  },
];
