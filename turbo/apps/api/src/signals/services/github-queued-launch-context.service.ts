import { chatEvents } from "@vm0/db/schema/chat-event";
import { chatGithubContext } from "@vm0/db/schema/chat-github-context";
import { githubChatThreadRoutes } from "@vm0/db/schema/github-chat-thread-route";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  githubDeliveryTargetSchema,
  type GitHubDeliveryTarget,
} from "./github-chat-callback-payload";
import { buildGitHubPrompt } from "./github-chat-prompt.service";

export interface GitHubQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly githubDelivery: GitHubDeliveryTarget;
}

type GitHubLaunchContextRow = Pick<
  typeof chatGithubContext.$inferSelect,
  | "repo"
  | "subjectNumber"
  | "subjectKind"
  | "triggerCommentId"
  | "issueContext"
  | "messageText"
  | "triggerReactionId"
  | "triggerCommentBody"
> & {
  readonly installationId: string;
  readonly agentId: string;
};

function requiredGitHubLaunchContext(row: GitHubLaunchContextRow | undefined) {
  if (!row || row.issueContext === null || row.messageText === null) {
    return null;
  }
  return {
    ...row,
    issueContext: row.issueContext,
    messageText: row.messageText,
  };
}

async function loadGitHubLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      repo: chatGithubContext.repo,
      subjectNumber: chatGithubContext.subjectNumber,
      subjectKind: chatGithubContext.subjectKind,
      triggerCommentId: chatGithubContext.triggerCommentId,
      issueContext: chatGithubContext.issueContext,
      messageText: chatGithubContext.messageText,
      triggerReactionId: chatGithubContext.triggerReactionId,
      triggerCommentBody: chatGithubContext.triggerCommentBody,
      installationId: githubChatThreadRoutes.installationId,
      agentId: chatThreads.agentComposeId,
    })
    .from(chatEvents)
    .innerJoin(
      chatGithubContext,
      and(
        eq(chatGithubContext.id, chatEvents.contextId),
        eq(chatGithubContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      githubChatThreadRoutes,
      and(
        eq(githubChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(githubChatThreadRoutes.repo, chatGithubContext.repo),
        eq(
          githubChatThreadRoutes.subjectNumber,
          chatGithubContext.subjectNumber,
        ),
        eq(githubChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      githubInstallations,
      and(
        eq(githubInstallations.id, githubChatThreadRoutes.installationId),
        eq(githubInstallations.orgId, args.orgId),
      ),
    )
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, chatEvents.chatThreadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "github"),
        eq(chatEvents.triggerSource, "github"),
      ),
    )
    .limit(1);
  return requiredGitHubLaunchContext(row);
}

export async function loadGitHubQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<GitHubQueuedLaunchMaterial | null> {
  const context = await loadGitHubLaunchContext(db, args);
  if (!context) {
    return null;
  }
  return {
    prompt: context.messageText,
    appendSystemPrompt: buildGitHubPrompt({
      issueContext: context.issueContext,
      repo: context.repo,
      issueNumber: context.subjectNumber,
      subjectKind: context.subjectKind,
    }),
    githubDelivery: githubDeliveryTargetSchema.parse({
      installationId: context.installationId,
      repo: context.repo,
      subjectNumber: context.subjectNumber,
      subjectKind: context.subjectKind,
      agentId: context.agentId,
      ...(context.triggerCommentId !== null
        ? { triggerCommentId: context.triggerCommentId }
        : {}),
      ...(context.triggerReactionId !== null
        ? { triggerReactionId: context.triggerReactionId }
        : {}),
      ...(context.triggerCommentBody !== null
        ? { triggerCommentBody: context.triggerCommentBody }
        : {}),
    }),
  };
}
