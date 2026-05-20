import { randomBytes } from "node:crypto";

import {
  githubIssuesCallbackPayloadSchema,
  type GitHubIssuesCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-github-issues";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";
import {
  addGithubCommentReaction,
  fetchGithubIssueComments,
  postGithubIssueCommentBestEffort,
  removeGithubCommentReaction,
  type GithubIssueComment,
} from "./github-issues-api.service";
import { getGithubInstallationAccessToken } from "./github-app.service";
import { encryptPersistentSecretValue } from "./crypto.utils";
import { loadComposeFeatureSwitchContext } from "./github-oauth.service";
import { createZeroIntegrationRun$ } from "./zero-runs-create.service";

const L = logger("WebhookGithub");

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

const gitHubInstallationRefSchema = z.object({
  id: z.number(),
});

export const gitHubIssuesEventSchema = z.object({
  action: z.string(),
  issue: gitHubIssueSchema,
  label: gitHubLabelSchema.optional(),
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationRefSchema,
  sender: gitHubUserSchema,
});

export const gitHubIssueCommentEventSchema = z.object({
  action: z.string(),
  issue: gitHubIssueSchema,
  comment: gitHubCommentSchema,
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationRefSchema,
  sender: gitHubUserSchema,
});

const gitHubInstallationAccountSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

export const gitHubInstallationEventSchema = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: gitHubInstallationAccountSchema,
  }),
  sender: z
    .object({
      id: z.number(),
      login: z.string(),
    })
    .optional(),
});

type GitHubIssue = z.infer<typeof gitHubIssueSchema>;
type GitHubComment = z.infer<typeof gitHubCommentSchema>;
type GitHubIssuesEvent = z.infer<typeof gitHubIssuesEventSchema>;
type GitHubIssueCommentEvent = z.infer<typeof gitHubIssueCommentEventSchema>;
type GitHubInstallationEvent = z.infer<typeof gitHubInstallationEventSchema>;
type GitHubInstallationRecord = typeof githubInstallations.$inferSelect;

interface DispatchParams {
  readonly ghInstallationId: string;
  readonly repo: string;
  readonly issue: GitHubIssue;
  readonly senderGithubUserId: string;
  readonly prompt: string;
  readonly commentId?: string;
  readonly comment?: GitHubComment;
  readonly forceNewSession?: boolean;
  readonly appSlug?: string;
  readonly apiStartTime: number;
}

type ExistingSessionResult =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "resolved";
      readonly sessionId: string | undefined;
      readonly lastCommentId: string | null | undefined;
    };

interface GitHubRunTarget {
  readonly composeId: string;
  readonly orgId: string;
  readonly zeroAgentId: string;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildIntegrationPrompt(platform: "GitHub"): string {
  return `# Current Integration\nYou are currently running inside: ${platform}`;
}

function buildGitHubPrompt(issueContext: string): string {
  return [buildIntegrationPrompt("GitHub"), issueContext]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

function buildIssuePrompt(issue: GitHubIssue): string {
  return issue.body ?? issue.title;
}

function buildCommentPrompt(comment: GitHubComment): string {
  return comment.body;
}

function buildPromptParts(
  prompt: string,
  issueContext: string,
  isCommentTrigger: boolean,
): {
  readonly prompt: string;
  readonly appendSystemPrompt: string | undefined;
} {
  const appendSystemPrompt = buildGitHubPrompt(issueContext) || undefined;
  const userPrompt = isCommentTrigger
    ? prompt
    : issueContext
      ? "Based on the GitHub issue above and its discussion, analyze the request and decide on the appropriate action."
      : prompt;

  return { prompt: userPrompt, appendSystemPrompt };
}

function formatIssueContext(args: {
  readonly issue: GitHubIssue;
  readonly comments: readonly GithubIssueComment[];
  readonly lastCommentId: string | undefined;
  readonly currentCommentId: string | undefined;
}): string {
  let relevantComments = args.lastCommentId
    ? args.comments.filter((comment) => {
        return comment.id > Number(args.lastCommentId);
      })
    : args.comments;

  if (args.currentCommentId) {
    relevantComments = relevantComments.filter((comment) => {
      return String(comment.id) !== args.currentCommentId;
    });
  }

  if (relevantComments.length === 0 && args.lastCommentId) {
    return "";
  }

  const parts: string[] = ["# GitHub Issue Context"];

  if (!args.lastCommentId) {
    parts.push(
      "",
      `**${args.issue.title}** (#${args.issue.number})`,
      "",
      args.issue.body ?? "_No description provided._",
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

async function getGitHubToken(args: {
  readonly ghInstallationId: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    return undefined;
  }

  const { token } = await getGithubInstallationAccessToken({
    appId,
    privateKey,
    installationId: args.ghInstallationId,
    signal: args.signal,
  });
  return token;
}

async function getGitHubTokenForInstallation(args: {
  readonly installation: GitHubInstallationRecord;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.installation.installationId) {
    return undefined;
  }

  const token = await getGitHubToken({
    ghInstallationId: args.installation.installationId,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  return token;
}

async function validateSessionAgent(args: {
  readonly db: Db;
  readonly sessionId: string;
  readonly vm0UserId: string;
  readonly expectedComposeId: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const [session] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.userId, args.vm0UserId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (session?.agentComposeId === args.expectedComposeId) {
    return args.sessionId;
  }
  return undefined;
}

async function resolveExistingSession(args: {
  readonly db: Db;
  readonly installationDbId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly composeId: string;
  readonly vm0UserId: string;
  readonly commentId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<ExistingSessionResult> {
  const [found] = await args.db
    .select({
      agentSessionId: githubIssueSessions.agentSessionId,
      lastCommentId: githubIssueSessions.lastCommentId,
    })
    .from(githubIssueSessions)
    .where(
      and(
        eq(githubIssueSessions.installationId, args.installationDbId),
        eq(githubIssueSessions.repo, args.repo),
        eq(githubIssueSessions.issueNumber, args.issueNumber),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (!found) {
    return { kind: "resolved", sessionId: undefined, lastCommentId: undefined };
  }

  if (args.commentId && found.lastCommentId === args.commentId) {
    return { kind: "duplicate" };
  }

  const sessionId = await validateSessionAgent({
    db: args.db,
    sessionId: found.agentSessionId,
    vm0UserId: args.vm0UserId,
    expectedComposeId: args.composeId,
    signal: args.signal,
  });

  return {
    kind: "resolved",
    sessionId,
    lastCommentId: sessionId ? found.lastCommentId : undefined,
  };
}

function createRunErrorMessage(result: {
  readonly status: number;
  readonly body: unknown;
}): string {
  if (
    typeof result.body === "object" &&
    result.body !== null &&
    "error" in result.body
  ) {
    const error = result.body.error;
    if (
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
    ) {
      return error.message;
    }
  }
  return `GitHub-triggered agent run failed with status ${result.status}`;
}

async function handleDispatchError(args: {
  readonly error: unknown;
  readonly token: string | undefined;
  readonly repo: string;
  readonly issueNumber: number;
  readonly commentId: string | undefined;
  readonly reactionId: string | undefined;
  readonly commentBody: string | undefined;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.token && args.commentId && args.reactionId) {
    await removeGithubCommentReaction({
      token: args.token,
      repo: args.repo,
      commentId: args.commentId,
      reactionId: args.reactionId,
      signal: args.signal,
    });
  }

  const quotePrefix = args.commentBody
    ? `${args.commentBody
        .split("\n")
        .map((line) => {
          return `> ${line}`;
        })
        .join("\n")}\n\n`
    : "";

  if (args.token) {
    const message =
      args.error instanceof Error
        ? args.error.message
        : "An unexpected error occurred.";
    await postGithubIssueCommentBestEffort({
      token: args.token,
      repo: args.repo,
      issueNumber: args.issueNumber,
      body: `${quotePrefix}Failed to start the agent: ${message}`,
      signal: args.signal,
    });
  }
}

async function loadActiveInstallation(args: {
  readonly db: Db;
  readonly ghInstallationId: string;
  readonly signal: AbortSignal;
}): Promise<GitHubInstallationRecord> {
  const [installation] = await args.db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.installationId, args.ghInstallationId),
        eq(githubInstallations.status, "active"),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (!installation) {
    throw new Error(
      `GitHub installation not found: installationId=${args.ghInstallationId}`,
    );
  }

  return installation;
}

async function maybeAddCommentReaction(args: {
  readonly token: string | undefined;
  readonly repo: string;
  readonly commentId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  if (!args.token || !args.commentId) {
    return undefined;
  }

  return await addGithubCommentReaction({
    token: args.token,
    repo: args.repo,
    commentId: args.commentId,
    content: "eyes",
    signal: args.signal,
  });
}

async function loadLinkedVm0UserId(args: {
  readonly db: Db;
  readonly githubUserId: string;
  readonly installationDbId: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const [userLink] = await args.db
    .select({ vm0UserId: githubUserLinks.vm0UserId })
    .from(githubUserLinks)
    .where(
      and(
        eq(githubUserLinks.githubUserId, args.githubUserId),
        eq(githubUserLinks.installationId, args.installationDbId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  return userLink?.vm0UserId;
}

async function loadGitHubRunTarget(args: {
  readonly db: Db;
  readonly installation: GitHubInstallationRecord;
  readonly signal: AbortSignal;
}): Promise<GitHubRunTarget> {
  const [compose] = await args.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, args.installation.defaultComposeId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!compose) {
    throw new Error(
      `Agent compose not found: composeId=${args.installation.defaultComposeId}`,
    );
  }

  const [agent] = await args.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, compose.orgId),
        eq(zeroAgents.name, compose.name),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  if (!agent) {
    throw new Error(
      `Zero agent not found for compose: composeId=${compose.id}`,
    );
  }

  return {
    composeId: compose.id,
    orgId: compose.orgId,
    zeroAgentId: agent.id,
  };
}

async function resolveDispatchSession(args: {
  readonly db: Db;
  readonly params: DispatchParams;
  readonly installationDbId: string;
  readonly issueNumber: number;
  readonly composeId: string;
  readonly vm0UserId: string;
  readonly signal: AbortSignal;
}): Promise<ExistingSessionResult> {
  if (args.params.forceNewSession) {
    return { kind: "resolved", sessionId: undefined, lastCommentId: undefined };
  }

  return await resolveExistingSession({
    db: args.db,
    installationDbId: args.installationDbId,
    repo: args.params.repo,
    issueNumber: args.issueNumber,
    composeId: args.composeId,
    vm0UserId: args.vm0UserId,
    commentId: args.params.commentId,
    signal: args.signal,
  });
}

async function buildIssueContextForRun(args: {
  readonly token: string | undefined;
  readonly params: DispatchParams;
  readonly issueNumber: number;
  readonly existingSessionId: string | undefined;
  readonly lastCommentId: string | null | undefined;
  readonly signal: AbortSignal;
}): Promise<string> {
  if (!args.token) {
    return "";
  }

  const comments = await fetchGithubIssueComments({
    token: args.token,
    repo: args.params.repo,
    issueNumber: args.issueNumber,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  return formatIssueContext({
    issue: args.params.issue,
    comments,
    lastCommentId: args.existingSessionId
      ? (args.lastCommentId ?? undefined)
      : undefined,
    currentCommentId: args.params.commentId,
  });
}

function buildCallbackPayload(args: {
  readonly installationDbId: string;
  readonly params: DispatchParams;
  readonly issueNumber: number;
  readonly composeId: string;
  readonly existingSessionId: string | undefined;
  readonly reactionId: string | undefined;
}): GitHubIssuesCallbackPayload {
  return githubIssuesCallbackPayloadSchema.parse({
    installationId: args.installationDbId,
    repo: args.params.repo,
    issueNumber: args.issueNumber,
    agentId: args.composeId,
    existingSessionId: args.existingSessionId,
    triggerCommentId: args.params.commentId,
    triggerCommentBody: args.params.commentId
      ? args.params.comment?.body
      : undefined,
    triggerReactionId: args.reactionId,
  });
}

async function updateExistingSessionComment(args: {
  readonly db: Db;
  readonly installationDbId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly existingSessionId: string | undefined;
  readonly commentId: string | undefined;
}): Promise<void> {
  if (!args.existingSessionId || !args.commentId) {
    return;
  }

  await args.db
    .update(githubIssueSessions)
    .set({ lastCommentId: args.commentId, updatedAt: nowDate() })
    .where(
      and(
        eq(githubIssueSessions.installationId, args.installationDbId),
        eq(githubIssueSessions.repo, args.repo),
        eq(githubIssueSessions.issueNumber, args.issueNumber),
      ),
    );
}

export const handleGithubIssuesEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GitHubIssuesEvent;
      readonly appSlug: string | undefined;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { action, issue, label, repository, installation, sender } =
      args.payload;

    if (action !== "opened" && action !== "labeled") {
      L.debug("Ignoring issues event", { action });
      return;
    }

    if (!args.appSlug) {
      L.debug("Ignoring issues event: app slug not configured");
      return;
    }

    if (action === "labeled" && label?.name !== args.appSlug) {
      L.debug("Ignoring label that is not app slug", {
        label: label?.name,
        expected: args.appSlug,
      });
      return;
    }

    if (
      action === "opened" &&
      !issue.labels.some((candidate) => {
        return candidate.name === args.appSlug;
      })
    ) {
      L.debug("Ignoring opened issue without app slug label", {
        expected: args.appSlug,
      });
      return;
    }

    await set(
      dispatchGithubAgentRun$,
      {
        ghInstallationId: String(installation.id),
        repo: repository.full_name,
        issue,
        senderGithubUserId: String(sender.id),
        prompt: buildIssuePrompt(issue),
        forceNewSession: true,
        appSlug: args.appSlug,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

export const handleGithubIssueCommentEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GitHubIssueCommentEvent;
      readonly appSlug: string | undefined;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { action, issue, comment, repository, installation, sender } =
      args.payload;

    if (action !== "created") {
      L.debug("Ignoring issue_comment event", { action });
      return;
    }

    if (sender.type === "Bot") {
      L.debug("Ignoring comment from bot", { sender: sender.login });
      return;
    }

    if (!args.appSlug) {
      L.debug("Ignoring comment: app slug not configured");
      return;
    }

    const botMention = `@${args.appSlug}[bot]`;
    if (!comment.body.includes(botMention)) {
      L.debug("Ignoring comment: no bot mention", { expected: botMention });
      return;
    }

    await set(
      dispatchGithubAgentRun$,
      {
        ghInstallationId: String(installation.id),
        repo: repository.full_name,
        issue,
        senderGithubUserId: String(sender.id),
        prompt: buildCommentPrompt(comment),
        commentId: String(comment.id),
        comment,
        appSlug: args.appSlug,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

const dispatchGithubAgentRun$ = command(
  async (
    { set },
    params: DispatchParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const issueNumber = params.issue.number;

    const installation = await loadActiveInstallation({
      db,
      ghInstallationId: params.ghInstallationId,
      signal,
    });
    const token = await getGitHubTokenForInstallation({ installation, signal });
    signal.throwIfAborted();

    const reactionId = await maybeAddCommentReaction({
      token,
      repo: params.repo,
      commentId: params.commentId,
      signal,
    });
    signal.throwIfAborted();

    const vm0UserId = await loadLinkedVm0UserId({
      db,
      githubUserId: params.senderGithubUserId,
      installationDbId: installation.id,
      signal,
    });
    if (!vm0UserId) {
      L.warn("No VM0 user linked for GitHub user", {
        githubUserId: params.senderGithubUserId,
        installationId: installation.id,
      });
      return;
    }

    const target = await loadGitHubRunTarget({ db, installation, signal });
    const sessionResult = await resolveDispatchSession({
      db,
      params,
      installationDbId: installation.id,
      issueNumber,
      composeId: target.composeId,
      vm0UserId,
      signal,
    });
    if (sessionResult.kind === "duplicate") {
      return;
    }

    const existingSessionId = sessionResult.sessionId;
    const issueContext = await buildIssueContextForRun({
      token,
      params,
      issueNumber,
      existingSessionId,
      lastCommentId: sessionResult.lastCommentId,
      signal,
    });
    const promptParts = buildPromptParts(
      params.prompt,
      issueContext,
      Boolean(params.commentId),
    );

    const callbackPayload = buildCallbackPayload({
      installationDbId: installation.id,
      params,
      issueNumber,
      composeId: target.composeId,
      existingSessionId,
      reactionId,
    });

    const dispatchResult = await settle(
      (async () => {
        const result = await set(
          createZeroIntegrationRun$,
          {
            userId: vm0UserId,
            orgId: target.orgId,
            agentId: target.zeroAgentId,
            sessionId: existingSessionId,
            prompt: promptParts.prompt,
            appendSystemPrompt: promptParts.appendSystemPrompt,
            triggerSource: "github",
            callbacks: [
              {
                url: `${env("VM0_API_URL")}/api/internal/callbacks/github/issues`,
                secret: generateCallbackSecret(),
                payload: callbackPayload,
              },
            ],
            apiStartTime: params.apiStartTime,
          },
          signal,
        );
        signal.throwIfAborted();

        if (result.status !== 201) {
          throw new Error(createRunErrorMessage(result));
        }

        L.debug("Agent run dispatched for GitHub issue", {
          runId: result.body.runId,
          repo: params.repo,
          issueNumber,
        });

        await updateExistingSessionComment({
          db,
          installationDbId: installation.id,
          repo: params.repo,
          issueNumber,
          existingSessionId,
          commentId: params.commentId,
        });
        signal.throwIfAborted();
      })(),
    );
    signal.throwIfAborted();

    if (!dispatchResult.ok) {
      await handleDispatchError({
        error: dispatchResult.error,
        token,
        repo: params.repo,
        issueNumber,
        commentId: params.commentId,
        reactionId,
        commentBody: params.comment?.body,
        signal,
      });
      signal.throwIfAborted();
      throw dispatchResult.error;
    }
  },
);

export const handleGithubInstallationEvent$ = command(
  async (
    { set },
    payload: GitHubInstallationEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    if (payload.action !== "created") {
      L.debug("Ignoring installation event", { action: payload.action });
      return;
    }

    const db = set(writeDb$);
    const targetId = String(payload.installation.account.id);
    const ghInstallationId = String(payload.installation.id);

    const [pending] = await db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.targetId, targetId),
          eq(githubInstallations.status, "pending"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!pending) {
      L.debug("No pending installation found for target", { targetId });
      return;
    }

    const appId = optionalEnv("GITHUB_APP_ID");
    const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
    if (!appId || !privateKey) {
      throw new Error(
        "GitHub App not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing), cannot activate pending installation",
      );
    }

    const { token } = await getGithubInstallationAccessToken({
      appId,
      privateKey,
      installationId: ghInstallationId,
      signal,
    });
    signal.throwIfAborted();
    const featureSwitchContext = await loadComposeFeatureSwitchContext({
      db,
      composeId: pending.defaultComposeId,
      signal,
    });

    await db
      .update(githubInstallations)
      .set({
        status: "active",
        installationId: ghInstallationId,
        encryptedAccessToken: await encryptPersistentSecretValue(
          token,
          featureSwitchContext,
        ),
        targetName: payload.installation.account.login,
        adminGithubUserId: payload.sender ? String(payload.sender.id) : null,
        updatedAt: nowDate(),
      })
      .where(eq(githubInstallations.id, pending.id));
    signal.throwIfAborted();

    L.debug("Activated pending GitHub installation", {
      installationId: ghInstallationId,
      targetId,
      recordId: pending.id,
    });
  },
);
