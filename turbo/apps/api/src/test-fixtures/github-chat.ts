import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { githubChatThreadRoutes } from "@vm0/db/schema/github-chat-thread-route";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { signGithubConnectParams } from "../signals/services/github-oauth.service";
import { dispatchGitHubChatDeliveryOnce } from "../signals/services/internal-github-chat-run-callback.service";

export interface GitHubRunStateFixture {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly continuedFromSessionId: string | null;
  readonly appendSystemPrompt: string | null;
  readonly chatThreadId: string | null;
  readonly triggerSource: string | null;
}

export function signGitHubConnectParamsFixture(args: {
  readonly installationId: string;
  readonly githubUserId: string;
  readonly githubUsername: string;
  readonly timestamp: number;
  readonly secretsEncryptionKey: string;
}): string {
  return signGithubConnectParams(args);
}

export async function findGitHubInstallationIdFixture(
  remoteInstallationId: string,
): Promise<string> {
  const [installation] = await db().query.githubInstallations.findMany({
    where: (table, operators) => {
      return operators.eq(table.installationId, remoteInstallationId);
    },
    limit: 1,
  });
  if (!installation) {
    throw new Error("Expected GitHub installation");
  }
  return installation.id;
}

export async function findGitHubRunStateFixture(
  userId: string,
  prompt: string,
): Promise<GitHubRunStateFixture> {
  const [run] = await db()
    .select({
      id: agentRuns.id,
      userId: agentRuns.userId,
      sessionId: agentRuns.sessionId,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      chatThreadId: zeroRuns.chatThreadId,
      triggerSource: zeroRuns.triggerSource,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.prompt, prompt)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  if (!run) {
    throw new Error(`Expected GitHub run for prompt: ${prompt}`);
  }
  return run;
}

export async function listGitHubChatRoutesFixture(args: {
  readonly installationId: string;
  readonly repo: string;
  readonly subjectNumber: number;
}) {
  return await db()
    .select({
      userId: githubChatThreadRoutes.userId,
      chatThreadId: githubChatThreadRoutes.chatThreadId,
      lastCommentId: githubChatThreadRoutes.lastCommentId,
    })
    .from(githubChatThreadRoutes)
    .where(
      and(
        eq(githubChatThreadRoutes.installationId, args.installationId),
        eq(githubChatThreadRoutes.repo, args.repo),
        eq(githubChatThreadRoutes.subjectNumber, args.subjectNumber),
      ),
    );
}

export async function readGitHubLegacySessionFixture(args: {
  readonly installationId: string;
  readonly repo: string;
  readonly subjectNumber: number;
}) {
  const [session] = await db()
    .select({
      userId: githubIssueSessions.userId,
      sessionId: githubIssueSessions.agentSessionId,
      lastCommentId: githubIssueSessions.lastCommentId,
    })
    .from(githubIssueSessions)
    .where(
      and(
        eq(githubIssueSessions.installationId, args.installationId),
        eq(githubIssueSessions.repo, args.repo),
        eq(githubIssueSessions.issueNumber, args.subjectNumber),
      ),
    )
    .limit(1);
  return session;
}

export async function countGitHubRunsByPromptFixture(
  userId: string,
  prompt: string,
): Promise<number> {
  const runs = await db()
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), eq(agentRuns.prompt, prompt)));
  return runs.length;
}

export async function retryGitHubChatDeliveryFixture(args: {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly signal: AbortSignal;
}): Promise<void> {
  const [callback] = await db()
    .select({ id: agentRunCallbacks.id })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "github:chat"),
      ),
    )
    .limit(1);
  if (!callback) {
    throw new Error("Expected canonical GitHub delivery callback");
  }
  await dispatchGitHubChatDeliveryOnce(
    db(),
    callback.id,
    args.status,
    args.signal,
  );
}
