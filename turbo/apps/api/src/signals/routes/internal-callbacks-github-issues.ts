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
import { zeroRuns } from "@vm0/db/schema/zero-run";
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
import { resolveGithubAgentReplyFooterText } from "../services/zero-github-footer.service";
import { formatRunErrorLikeWebMessage } from "../services/zero-chat-thread.service";

const L = logger("InternalCallbacksGithubIssues");
const RUN_COMPLETED_FALLBACK_MESSAGE = "Task completed successfully.";
const RUN_FAILED_FALLBACK_MESSAGE =
  "The agent encountered an error during execution.";

interface GitHubRunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string | null;
}

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
    const updated = await args.db
      .update(githubIssueSessions)
      .set({
        userId: run.userId,
        agentSessionId: newSessionId,
        lastCommentId: args.commentId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(githubIssueSessions.installationId, args.installationId),
          eq(githubIssueSessions.repo, args.repo),
          eq(githubIssueSessions.issueNumber, args.issueNumber),
        ),
      )
      .returning({ id: githubIssueSessions.id });
    args.signal.throwIfAborted();

    if (updated.length > 0) {
      return;
    }

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

function escapeGitHubSubText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function buildGitHubResponse(args: {
  readonly markdown: string;
  readonly logsUrl?: string;
  readonly footerText?: string;
}): string {
  const parts = [args.markdown];
  const footerParts: string[] = [];
  if (args.logsUrl) {
    footerParts.push(`📋 [Audit](${args.logsUrl})`);
  }
  if (args.footerText) {
    footerParts.push(escapeGitHubSubText(args.footerText));
  }
  if (footerParts.length > 0) {
    parts.push(`<sub>${footerParts.join(" · ")}</sub>`);
  }
  return parts.join("\n\n");
}

function formatGitHubComment(args: {
  readonly response: string;
  readonly logsUrl?: string;
  readonly footerText?: string;
  readonly triggerCommentBody?: string;
}): string {
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

  parts.push(
    buildGitHubResponse({
      markdown: args.response,
      logsUrl: args.logsUrl,
      footerText: args.footerText,
    }),
  );

  return parts.join("\n");
}

async function loadGitHubRunContext(args: {
  readonly db: Db;
  readonly runId: string;
  readonly signal: AbortSignal;
}): Promise<GitHubRunContext | undefined> {
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      chatThreadId: zeroRuns.chatThreadId,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();
  return run;
}

async function resolveGitHubAuditLogsUrl(args: {
  readonly runId: string;
  readonly run: GitHubRunContext | undefined;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.run) {
    return undefined;
  }

  const overrides = await args.getFeatureOverrides(
    args.run.orgId,
    args.run.userId,
  );
  args.signal.throwIfAborted();
  const typedOverrides =
    Object.keys(overrides).length > 0
      ? (overrides as Partial<Record<FeatureSwitchKey, boolean>>)
      : undefined;
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: args.run.userId,
    orgId: args.run.orgId,
    overrides: typedOverrides,
  });
  if (!enabled) {
    return undefined;
  }

  return `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`;
}

async function resolveGitHubRunError(args: {
  readonly run: GitHubRunContext | undefined;
  readonly runId: string;
  readonly errorMessage: string | undefined;
  readonly formatRunError: (params: {
    readonly chatThreadId: string | null | undefined;
    readonly runId: string;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly signal: AbortSignal;
}): Promise<string> {
  return await args.formatRunError({
    chatThreadId: args.run?.chatThreadId,
    runId: args.runId,
    errorMessage:
      args.errorMessage ?? "The agent encountered an error during execution.",
  });
}

async function buildGitHubCompletionComment(args: {
  readonly db: Db;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly error: string | undefined;
  readonly installationId: string;
  readonly agentId: string;
  readonly triggerCommentBody: string | undefined;
  readonly getFeatureOverrides: (
    orgId: string,
    userId: string,
  ) => Promise<Record<string, boolean>>;
  readonly formatRunError: (params: {
    readonly chatThreadId: string | null | undefined;
    readonly runId: string;
    readonly errorMessage: string;
  }) => Promise<string>;
  readonly signal: AbortSignal;
}): Promise<string> {
  const run = await loadGitHubRunContext({
    db: args.db,
    runId: args.runId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const output =
    args.status === "completed"
      ? await getRunOutputText(args.runId, { signal: args.signal })
      : undefined;
  args.signal.throwIfAborted();

  const logsUrl = await resolveGitHubAuditLogsUrl({
    runId: args.runId,
    run,
    getFeatureOverrides: args.getFeatureOverrides,
    signal: args.signal,
  });
  const footerText = run
    ? await resolveGithubAgentReplyFooterText({
        db: args.db,
        orgId: run.orgId,
        runId: args.runId,
        installationId: args.installationId,
        agentId: args.agentId,
      })
    : undefined;
  args.signal.throwIfAborted();

  const errorDetail =
    args.status === "failed"
      ? await resolveGitHubRunError({
          run,
          runId: args.runId,
          errorMessage: args.error,
          formatRunError: args.formatRunError,
          signal: args.signal,
        })
      : undefined;
  args.signal.throwIfAborted();

  const responseText =
    args.status === "completed"
      ? (output ?? RUN_COMPLETED_FALLBACK_MESSAGE)
      : (errorDetail ?? RUN_FAILED_FALLBACK_MESSAGE);

  return formatGitHubComment({
    response: responseText,
    logsUrl,
    footerText,
    triggerCommentBody: args.triggerCommentBody,
  });
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

    const commentBody = await buildGitHubCompletionComment({
      db,
      runId,
      status,
      error,
      installationId,
      agentId,
      triggerCommentBody: payload.triggerCommentBody,
      getFeatureOverrides: (orgId, userId) => {
        return get(userFeatureSwitchOverrides(orgId, userId));
      },
      formatRunError: (params) => {
        return get(formatRunErrorLikeWebMessage(params));
      },
      signal,
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
