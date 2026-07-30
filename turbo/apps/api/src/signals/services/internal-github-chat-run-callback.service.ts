import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { githubChatThreadRoutes } from "@vm0/db/schema/github-chat-thread-route";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import type { Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { now, nowDate } from "../external/time";
import { settleIncludingAbort } from "../utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { getGithubInstallationAccessToken } from "./github-app.service";
import {
  githubChatCallbackPayloadSchema,
  type GitHubDeliveryTarget,
} from "./github-chat-callback-payload";
import {
  postGithubIssueComment,
  removeGithubCommentReaction,
} from "./github-issues-api.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { resolveGithubAgentReplyFooterText } from "./zero-github-footer.service";

const L = logger("InternalCallbacksGithubChat");

interface ClaimedGitHubChatDelivery {
  readonly runId: string;
  readonly payload: unknown;
}

interface GitHubChatRunContext {
  readonly userId: string;
  readonly orgId: string;
  readonly sessionId: string;
  readonly chatThreadId: string;
  readonly agentId: string;
}

async function markDelivered(db: Db, callbackId: string): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "delivered", deliveredAt: nowDate() })
    .where(eq(agentRunCallbacks.id, callbackId));
}

async function markFailed(
  db: Db,
  callbackId: string,
  error: string,
): Promise<void> {
  await db
    .update(agentRunCallbacks)
    .set({ status: "failed", lastError: error.slice(0, 4000) })
    .where(eq(agentRunCallbacks.id, callbackId));
}

function recordDelivery(args: {
  readonly runId: string;
  readonly startedAt: number;
  readonly success: boolean;
  readonly outcome: "delivered" | "failed" | "skipped_revoked";
}): void {
  recordSandboxOperation({
    sandboxType: "chat",
    actionType: "github_chat_delivery",
    durationMs: Math.max(0, now() - args.startedAt),
    success: args.success,
    runId: args.runId,
    dimensions: { outcome: args.outcome },
  });
}

async function claimGitHubChatDelivery(
  db: Db,
  callbackId: string,
): Promise<ClaimedGitHubChatDelivery | undefined> {
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({ attempts: 1, lastAttemptAt: nowDate() })
    .where(
      and(
        eq(agentRunCallbacks.id, callbackId),
        eq(agentRunCallbacks.internalKind, "github:chat"),
        eq(agentRunCallbacks.status, "pending"),
        eq(agentRunCallbacks.attempts, 0),
      ),
    )
    .returning({
      runId: agentRunCallbacks.runId,
      payload: agentRunCallbacks.payload,
    });
  return callback;
}

async function loadGitHubChatDeliveryContext(args: {
  readonly db: Db;
  readonly callback: ClaimedGitHubChatDelivery;
  readonly signal: AbortSignal;
}) {
  const payload = githubChatCallbackPayloadSchema.parse(args.callback.payload);
  const [run] = await args.db
    .select({
      userId: agentRuns.userId,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
      chatThreadId: zeroRuns.chatThreadId,
      agentId: chatThreads.agentComposeId,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .innerJoin(chatThreads, eq(chatThreads.id, zeroRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, args.callback.runId),
        eq(zeroRuns.triggerSource, "github"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!run?.chatThreadId || run.agentId !== payload.agentId) {
    throw new Error("GitHub chat delivery run context is unavailable");
  }
  const runContext: GitHubChatRunContext = {
    userId: run.userId,
    orgId: run.orgId,
    sessionId: run.sessionId,
    chatThreadId: run.chatThreadId,
    agentId: run.agentId,
  };

  const [event] = await args.db
    .select({ content: chatEvents.content })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, payload.chatMessageId),
        eq(chatEvents.runId, args.callback.runId),
        eq(chatEvents.chatThreadId, runContext.chatThreadId),
        chatEventTypeIn([
          "output.message",
          "output.error",
          "run.failed",
          "run.cancelled",
        ]),
        isNotNull(chatEvents.content),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!event?.content) {
    throw new Error("GitHub chat delivery message is unavailable");
  }

  const [installation] = await args.db
    .select({
      installationId: githubInstallations.installationId,
    })
    .from(githubChatThreadRoutes)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubChatThreadRoutes.installationId),
    )
    .where(
      and(
        eq(githubChatThreadRoutes.installationId, payload.installationId),
        eq(githubChatThreadRoutes.repo, payload.repo),
        eq(githubChatThreadRoutes.subjectNumber, payload.subjectNumber),
        eq(githubChatThreadRoutes.userId, runContext.userId),
        eq(githubChatThreadRoutes.chatThreadId, runContext.chatThreadId),
        eq(githubInstallations.orgId, runContext.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  return {
    payload,
    run: runContext,
    messageContent: event.content,
    ghInstallationId: installation?.installationId,
  };
}

function escapeGitHubSubText(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function formatGitHubComment(args: {
  readonly response: string;
  readonly logsUrl?: string;
  readonly footerText?: string;
  readonly triggerCommentBody?: string;
}): string {
  const parts: string[] = [];
  if (args.triggerCommentBody) {
    parts.push(
      args.triggerCommentBody
        .split("\n")
        .map((line) => {
          return `> ${line}`;
        })
        .join("\n"),
      "",
    );
  }
  const footerParts: string[] = [];
  if (args.logsUrl) {
    footerParts.push(`📋 [Audit](${args.logsUrl})`);
  }
  if (args.footerText) {
    footerParts.push(escapeGitHubSubText(args.footerText));
  }
  parts.push(
    footerParts.length > 0
      ? `${args.response}\n\n<sub>${footerParts.join(" · ")}</sub>`
      : args.response,
  );
  return parts.join("\n");
}

async function githubAccessToken(args: {
  readonly ghInstallationId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    throw new Error("GitHub App not configured");
  }
  const { token } = await getGithubInstallationAccessToken({
    appId,
    privateKey,
    installationId: args.ghInstallationId,
    signal: args.signal,
  });
  return token;
}

async function buildGitHubDeliveryComment(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: GitHubChatRunContext;
  readonly target: GitHubDeliveryTarget;
  readonly messageContent: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const featureContext = await loadUserFeatureSwitchContext(
    args.db,
    args.run.orgId,
    args.run.userId,
  );
  args.signal.throwIfAborted();
  const logsUrl = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, featureContext)
    ? `${env("APP_URL")}/activities/${encodeURIComponent(args.runId)}`
    : undefined;
  const footerText = await resolveGithubAgentReplyFooterText({
    db: args.db,
    orgId: args.run.orgId,
    runId: args.runId,
    installationId: args.target.installationId,
    agentId: args.target.agentId,
  });
  args.signal.throwIfAborted();
  return formatGitHubComment({
    response: args.messageContent,
    logsUrl,
    footerText,
    triggerCommentBody: args.target.triggerCommentBody,
  });
}

async function deliverClaimedGitHubChatCallback(args: {
  readonly db: Db;
  readonly callback: ClaimedGitHubChatDelivery;
  readonly status: "completed" | "failed";
  readonly signal: AbortSignal;
}): Promise<"delivered" | "skipped_revoked"> {
  const context = await loadGitHubChatDeliveryContext(args);
  if (!context.ghInstallationId) {
    return "skipped_revoked";
  }
  const token = await githubAccessToken({
    ghInstallationId: context.ghInstallationId,
    signal: args.signal,
  });
  const body = await buildGitHubDeliveryComment({
    db: args.db,
    runId: args.callback.runId,
    run: context.run,
    target: context.payload,
    messageContent: context.messageContent,
    signal: args.signal,
  });
  await postGithubIssueComment({
    token,
    repo: context.payload.repo,
    issueNumber: context.payload.subjectNumber,
    body,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (context.payload.triggerCommentId && context.payload.triggerReactionId) {
    await removeGithubCommentReaction({
      token,
      repo: context.payload.repo,
      commentId: context.payload.triggerCommentId,
      reactionId: context.payload.triggerReactionId,
      signal: args.signal,
    });
    args.signal.throwIfAborted();
  }
  return "delivered";
}

export async function dispatchGitHubChatDeliveryOnce(
  db: Db,
  callbackId: string,
  status: "completed" | "failed",
  signal: AbortSignal,
): Promise<void> {
  const startedAt = now();
  signal.throwIfAborted();
  const callback = await claimGitHubChatDelivery(db, callbackId);
  if (!callback) {
    return;
  }
  const delivery = await settleIncludingAbort(
    deliverClaimedGitHubChatCallback({
      db,
      callback,
      status,
      signal,
    }),
  );
  if (!delivery.ok) {
    const message =
      delivery.error instanceof Error
        ? delivery.error.message
        : "Unknown error";
    await markFailed(db, callbackId, message);
    recordDelivery({
      runId: callback.runId,
      startedAt,
      success: false,
      outcome: "failed",
    });
    L.warn("Canonical GitHub delivery failed", {
      callbackId,
      runId: callback.runId,
      error: delivery.error,
    });
    return;
  }
  await markDelivered(db, callbackId);
  recordDelivery({
    runId: callback.runId,
    startedAt,
    success: true,
    outcome: delivery.value,
  });
}

export async function deliverGitHubChatAdmissionFailure(args: {
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly target: GitHubDeliveryTarget;
  readonly chatMessageId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const [event] = await args.db
    .select({ content: chatEvents.content })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.chatMessageId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        chatEventTypeIn(["output.error"]),
        isNotNull(chatEvents.content),
      ),
    )
    .limit(1);
  const [binding] = await args.db
    .select({ ghInstallationId: githubInstallations.installationId })
    .from(githubChatThreadRoutes)
    .innerJoin(
      githubInstallations,
      eq(githubInstallations.id, githubChatThreadRoutes.installationId),
    )
    .where(
      and(
        eq(githubChatThreadRoutes.installationId, args.target.installationId),
        eq(githubChatThreadRoutes.repo, args.target.repo),
        eq(githubChatThreadRoutes.subjectNumber, args.target.subjectNumber),
        eq(githubChatThreadRoutes.userId, args.userId),
        eq(githubChatThreadRoutes.chatThreadId, args.chatThreadId),
        eq(githubInstallations.orgId, args.orgId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();
  if (!event?.content || !binding?.ghInstallationId) {
    return;
  }
  const token = await githubAccessToken({
    ghInstallationId: binding.ghInstallationId,
    signal: args.signal,
  });
  const body = formatGitHubComment({
    response: event.content,
    triggerCommentBody: args.target.triggerCommentBody,
  });
  await postGithubIssueComment({
    token,
    repo: args.target.repo,
    issueNumber: args.target.subjectNumber,
    body,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  if (args.target.triggerCommentId && args.target.triggerReactionId) {
    await removeGithubCommentReaction({
      token,
      repo: args.target.repo,
      commentId: args.target.triggerCommentId,
      reactionId: args.target.triggerReactionId,
      signal: args.signal,
    });
  }
}
