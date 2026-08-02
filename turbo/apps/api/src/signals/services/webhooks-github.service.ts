import {
  githubDeploymentStateSchema,
  githubPullRequestReviewStateSchema,
  githubWorkflowRunConclusionSchema,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { githubChatThreadRoutes } from "@vm0/db/schema/github-chat-thread-route";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { nowDate } from "../external/time";
import {
  addGithubCommentReaction,
  fetchGithubIssueComments,
  postGithubIssueCommentBestEffort,
  removeGithubCommentReaction,
  type GithubIssueComment,
} from "./github-issues-api.service";
import { getGithubInstallationAccessToken } from "./github-app.service";
import { signGithubConnectParams } from "./github-oauth.service";
import { githubAppBotUsername } from "./github-chat-prompt.service";
import { resolveIntegrationModelRouteForUser$ } from "./integration-model-route.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { drainChatThreadQueueForThread$ } from "./chat-thread-queue-drain.service";
import {
  ensureGitHubChatThreadRoute,
  type GitHubChatThreadRouteBinding,
} from "./github-chat-ingress.service";
import { insertChatEvent } from "./zero-chat-event.service";
import { touchChatThreadLastMessageAt } from "./zero-chat-event-shared.service";
import { createChatEventSourcePart } from "./chat-event-annotation.service";
import { createUserMessageDocument } from "./zero-chat-user-message.service";
import { encryptQueuedUserMessageRunParams } from "./zero-chat-queued-event.service";
import { dispatchGithubLabelWorkflowAutomations$ } from "./github-workflow-event.service";
import {
  dispatchGithubWebhookAutomations$,
  type GithubDeploymentStatusEventPayload,
  type GithubIssueCommentEventPayload,
  type GithubPullRequestReviewEventPayload,
  type GithubWorkflowJobEventPayload,
} from "./github-webhook-automation-event.service";
import {
  dispatchGithubWorkflowRunAutomations$,
  type GithubWorkflowRunEventPayload,
} from "./github-workflow-run-event.service";

const L = logger("WebhookGithub");
const GITHUB_ALIAS_MENTION_HANDLES = ["@Zero[bot]", "@Zero"] as const;
const GITHUB_CHAT_MESSAGE_ID_NAMESPACE = "f9e495f0-f0e2-4e4d-b69f-6c8074630a90";

const gitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string(),
});

const gitHubLabelSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const gitHubPullRequestMarkerSchema = z.object({}).passthrough();

const gitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  labels: z.array(gitHubLabelSchema),
  user: gitHubUserSchema,
  pull_request: gitHubPullRequestMarkerSchema.optional(),
});

const gitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  user: gitHubUserSchema,
  author_association: z.string().optional(),
});

const gitHubRepositorySchema = z.object({
  id: z.number().optional(),
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

export const gitHubWorkflowJobEventSchema: z.ZodType<GithubWorkflowJobEventPayload> =
  z.object({
    action: z.string(),
    workflow_job: z.object({
      id: z.number(),
      run_id: z.number(),
      workflow_name: z.string().nullable(),
      head_branch: z.string().nullable(),
      head_sha: z.string(),
      run_url: z.string(),
      run_attempt: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: githubWorkflowRunConclusionSchema.nullable(),
      html_url: z.string(),
      labels: z.array(z.string()),
      runner_id: z.number().nullable().default(null),
      runner_name: z.string().nullable().default(null),
      runner_group_id: z.number().nullable().default(null),
      runner_group_name: z.string().nullable().default(null),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubPullRequestReviewEventSchema: z.ZodType<GithubPullRequestReviewEventPayload> =
  z.object({
    action: z.string(),
    review: z.object({
      id: z.number(),
      user: gitHubUserSchema,
      state: githubPullRequestReviewStateSchema,
      html_url: z.string(),
      commit_id: z.string(),
      submitted_at: z.string().nullable().default(null),
      author_association: z.string(),
    }),
    pull_request: z.object({
      number: z.number(),
      title: z.string(),
      html_url: z.string(),
      draft: z.boolean(),
      base: z.object({ ref: z.string() }),
      head: z.object({ ref: z.string() }),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

const gitHubAppReferenceSchema = z.object({
  id: z.number(),
  slug: z.string().nullable(),
  name: z.string().nullable(),
});

export const gitHubDeploymentStatusEventSchema: z.ZodType<GithubDeploymentStatusEventPayload> =
  z.object({
    action: z.string(),
    deployment_status: z.object({
      id: z.number(),
      state: githubDeploymentStateSchema,
      environment: z.string().nullable().default(null),
      environment_url: z.string().nullable().default(null),
      log_url: z.string().nullable().default(null),
      creator: gitHubUserSchema.nullable().default(null),
    }),
    deployment: z.object({
      id: z.number(),
      ref: z.string(),
      sha: z.string(),
      task: z.string(),
      environment: z.string(),
      production_environment: z.boolean(),
      transient_environment: z.boolean(),
      creator: gitHubUserSchema.nullable().default(null),
      performed_via_github_app: gitHubAppReferenceSchema
        .nullable()
        .default(null),
    }),
    repository: gitHubRepositorySchema,
    installation: gitHubInstallationRefSchema,
    sender: gitHubUserSchema,
  });

export const gitHubPullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: gitHubIssueSchema,
  label: gitHubLabelSchema.optional(),
  repository: gitHubRepositorySchema,
  installation: gitHubInstallationRefSchema,
  sender: gitHubUserSchema,
});

export const gitHubWorkflowRunEventSchema: z.ZodType<GithubWorkflowRunEventPayload> =
  z.object({
    action: z.string(),
    workflow_run: z.object({
      id: z.number(),
      workflow_id: z.number(),
      name: z.string().nullable(),
      path: z.string(),
      run_number: z.number(),
      run_attempt: z.number(),
      status: z.string(),
      conclusion: githubWorkflowRunConclusionSchema.nullable(),
      head_branch: z.string().nullable(),
      head_sha: z.string(),
      event: z.string(),
      html_url: z.string(),
      actor: gitHubUserSchema.nullable(),
      triggering_actor: gitHubUserSchema.nullable(),
      pull_requests: z.array(z.object({ number: z.number() })),
    }),
    repository: z.object({
      id: z.number(),
      full_name: z.string(),
    }),
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
type GitHubPullRequestEvent = z.infer<typeof gitHubPullRequestEventSchema>;
type GitHubInstallationEvent = z.infer<typeof gitHubInstallationEventSchema>;
type GitHubInstallationRecord = typeof githubInstallations.$inferSelect;
type GitHubAutomationKind = "issue" | "pull_request";

interface GitHubFileReference {
  readonly url: string;
  readonly filename?: string;
}

interface GitHubFileReferenceMatch extends GitHubFileReference {
  readonly start: number;
  readonly end: number;
}

interface DispatchParams {
  readonly ghInstallationId: string;
  readonly repo: string;
  readonly issue: GitHubIssue;
  readonly subjectKind: GitHubAutomationKind;
  readonly vm0UserId: string;
  readonly composeId: string;
  readonly prompt: string;
  readonly automationDescription?: string;
  readonly commentId?: string;
  readonly comment?: GitHubComment;
  readonly apiStartTime: number;
}

interface GitHubRunTarget {
  readonly composeId: string;
  readonly orgId: string;
}

function githubSubjectLabel(subjectKind: GitHubAutomationKind): string {
  return subjectKind === "pull_request" ? "Pull Request" : "Issue";
}

function githubSubjectUrl(args: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly subjectKind: GitHubAutomationKind;
}): string {
  const pathSegment = args.subjectKind === "pull_request" ? "pull" : "issues";
  return `https://github.com/${args.repo}/${pathSegment}/${args.issueNumber}`;
}

function githubAppMentionHandles(): readonly string[] {
  const handles: string[] = [...GITHUB_ALIAS_MENTION_HANDLES];
  const appSlug = optionalEnv("GITHUB_APP_SLUG")?.trim().replace(/^@+/, "");
  if (!appSlug) {
    return handles;
  }
  const normalizedSlug = appSlug.replace(/\[bot\]$/iu, "");
  return Array.from(
    new Set([`@${normalizedSlug}[bot]`, `@${normalizedSlug}`, ...handles]),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function githubCommentMentionsBot(body: string): boolean {
  const lowerBody = body.toLowerCase();
  return githubAppMentionHandles().some((handle) => {
    return lowerBody.includes(handle.toLowerCase());
  });
}

function stripGithubBotMention(body: string): string {
  return [...githubAppMentionHandles()]
    .sort((left, right) => {
      return right.length - left.length;
    })
    .reduce((text, handle) => {
      return text.replace(new RegExp(escapeRegExp(handle), "giu"), "");
    }, body)
    .trim();
}

function githubIssueCommentSubjectKind(
  issue: GitHubIssue,
): GitHubAutomationKind {
  return issue.pull_request === undefined ? "issue" : "pull_request";
}

function buildGithubMentionConnectUrl(args: {
  readonly ghInstallationId: string;
  readonly githubUserId: string;
  readonly githubUsername: string;
}): string {
  const timestamp = Math.floor(nowDate().getTime() / 1000);
  const params = new URLSearchParams({
    installation: args.ghInstallationId,
    ghUser: args.githubUserId,
    ghLogin: args.githubUsername,
    ts: String(timestamp),
    sig: signGithubConnectParams({
      installationId: args.ghInstallationId,
      githubUserId: args.githubUserId,
      githubUsername: args.githubUsername,
      timestamp,
      secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
    }),
  });

  return `${env("APP_URL").replace(/\/$/u, "")}/github/connect?${params.toString()}`;
}

function formatGithubConnectPrompt(args: {
  readonly agentName: string;
  readonly connectUrl: string;
}): string {
  return `To use ${args.agentName}, connect your GitHub account first.\n\n[Connect GitHub](${args.connectUrl})`;
}

function formatGithubContextSender(args: {
  readonly login: string;
  readonly type: string;
  readonly id?: number;
}): string {
  const senderParts =
    args.type === "Bot"
      ? ["id: BOT"]
      : [args.id !== undefined ? `id: ${args.id}` : null].filter(
          (part): part is string => {
            return part !== null;
          },
        );

  senderParts.push(`username: @${args.login}`, `type: ${args.type}`);
  return `{${senderParts.join(", ")}}`;
}

const GITHUB_FILE_URL_SOURCE = String.raw`https:\/\/(?:github\.com\/user-attachments\/(?:assets\/[A-Za-z0-9-]+|files\/[^\s)<>'"]+)|(?:raw|objects|private-user-images|user-images)\.githubusercontent\.com\/[^\s)<>'"]+)`;
const GITHUB_ASSET_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function githubMarkdownFileLinkRegex(): RegExp {
  return new RegExp(
    `!?\\[([^\\]]*)\\]\\((${GITHUB_FILE_URL_SOURCE})\\)`,
    "giu",
  );
}

function githubHtmlImageTagRegex(): RegExp {
  return new RegExp(
    `<img\\b[^>]*\\bsrc\\s*=\\s*["'](${GITHUB_FILE_URL_SOURCE})["'][^>]*>`,
    "giu",
  );
}

function githubFileUrlRegex(): RegExp {
  return new RegExp(GITHUB_FILE_URL_SOURCE, "giu");
}

function normalizeGithubFileUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function filenameFromGithubUrl(url: string): string | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  if (!segment || GITHUB_ASSET_ID_RE.test(segment)) {
    return undefined;
  }
  return segment;
}

function isUsefulFilenameCandidate(candidate: string): boolean {
  const trimmed = candidate.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 255 &&
    !trimmed.includes("/") &&
    !/^image$/iu.test(trimmed)
  );
}

function htmlAttributeValue(
  tag: string,
  attribute: string,
): string | undefined {
  const match = tag.match(
    new RegExp(
      `\\b${escapeRegExp(attribute)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
      "iu",
    ),
  );
  return match?.[1] ?? match?.[2];
}

function pushGithubFileReferenceMatch(
  matches: GitHubFileReferenceMatch[],
  args: {
    readonly start: number;
    readonly end: number;
    readonly url: string;
    readonly filenameCandidate?: string;
  },
): void {
  const normalizedUrl = normalizeGithubFileUrl(args.url);
  const filename =
    args.filenameCandidate && isUsefulFilenameCandidate(args.filenameCandidate)
      ? args.filenameCandidate.trim()
      : filenameFromGithubUrl(normalizedUrl);
  matches.push({
    start: args.start,
    end: args.end,
    url: normalizedUrl,
    ...(filename ? { filename } : {}),
  });
}

function overlapsGithubFileReferenceMatch(
  matches: readonly GitHubFileReferenceMatch[],
  start: number,
): boolean {
  return matches.some((candidate) => {
    return start >= candidate.start && start < candidate.end;
  });
}

function findGithubFileReferenceMatches(
  body: string,
): readonly GitHubFileReferenceMatch[] {
  const matches: GitHubFileReferenceMatch[] = [];
  for (const match of body.matchAll(githubHtmlImageTagRegex())) {
    const matchedText = match[0];
    const url = match[1];
    if (match.index !== undefined && matchedText && url) {
      const filenameCandidate = htmlAttributeValue(matchedText, "alt");
      pushGithubFileReferenceMatch(matches, {
        start: match.index,
        end: match.index + matchedText.length,
        url,
        ...(filenameCandidate ? { filenameCandidate } : {}),
      });
    }
  }

  for (const match of body.matchAll(githubMarkdownFileLinkRegex())) {
    const matchedText = match[0];
    const filenameCandidate = match[1];
    const url = match[2];
    if (
      match.index !== undefined &&
      matchedText &&
      url &&
      !overlapsGithubFileReferenceMatch(matches, match.index)
    ) {
      pushGithubFileReferenceMatch(matches, {
        start: match.index,
        end: match.index + matchedText.length,
        url,
        ...(filenameCandidate ? { filenameCandidate } : {}),
      });
    }
  }

  for (const match of body.matchAll(githubFileUrlRegex())) {
    const matchedText = match[0];
    const matchIndex = match.index;
    if (matchIndex === undefined || !matchedText) {
      continue;
    }
    if (overlapsGithubFileReferenceMatch(matches, matchIndex)) {
      continue;
    }

    const normalizedUrl = normalizeGithubFileUrl(matchedText);
    const filename = filenameFromGithubUrl(normalizedUrl);
    matches.push({
      start: matchIndex,
      end: matchIndex + normalizedUrl.length,
      url: normalizedUrl,
      ...(filename ? { filename } : {}),
    });
  }

  return [...matches].sort((left, right) => {
    return left.start - right.start;
  });
}

function formatGithubFileReference(file: GitHubFileReference): string {
  return [
    "[GitHub file]",
    `[URL] ${file.url}`,
    file.filename ? `[FILENAME] ${file.filename}` : null,
  ]
    .filter((line): line is string => {
      return line !== null;
    })
    .join("\n");
}

function replaceGithubFileReferencesForContext(body: string): string {
  const references = findGithubFileReferenceMatches(body);
  if (references.length === 0) {
    return body;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const reference of references) {
    parts.push(body.slice(cursor, reference.start));
    parts.push(formatGithubFileReference(reference));
    cursor = reference.end;
  }
  parts.push(body.slice(cursor));

  return parts.join("");
}

function formatGitHubIssueContextMessage(args: {
  readonly issue: GitHubIssue;
  readonly relativeIndex: number;
  readonly subjectLabel: string;
}): string {
  const body = args.issue.body
    ? replaceGithubFileReferencesForContext(args.issue.body)
    : "_No description provided._";
  return [
    "---",
    "",
    `- RELATIVE_INDEX: ${args.relativeIndex}`,
    `- MSG_ID: ${args.subjectLabel.toLowerCase().replaceAll(" ", "_")}:${args.issue.number}`,
    `- SENDER: ${formatGithubContextSender({
      id: args.issue.user.id,
      login: args.issue.user.login,
      type: args.issue.user.type,
    })}`,
    `- SOURCE: ${args.subjectLabel}`,
    "",
    `Title: ${args.issue.title}`,
    "",
    body,
  ]
    .filter((part): part is string => {
      return part !== null;
    })
    .join("\n");
}

function formatGitHubCommentContextMessage(args: {
  readonly comment: GithubIssueComment;
  readonly relativeIndex: number;
}): string {
  const body = replaceGithubFileReferencesForContext(args.comment.body);
  return [
    "---",
    "",
    `- RELATIVE_INDEX: ${args.relativeIndex}`,
    `- MSG_ID: comment:${args.comment.id}`,
    `- SENDER: ${formatGithubContextSender(args.comment.user)}`,
    "- SOURCE: comment",
    "",
    body,
  ]
    .filter((part): part is string => {
      return part !== null;
    })
    .join("\n");
}

function formatIssueContext(args: {
  readonly issue: GitHubIssue;
  readonly subjectKind: GitHubAutomationKind;
  readonly repo: string;
  readonly automationDescription: string | undefined;
  readonly comments: readonly GithubIssueComment[];
  readonly currentCommentId: string | undefined;
}): string {
  const relevantComments = args.currentCommentId
    ? args.comments.filter((comment) => {
        return String(comment.id) !== args.currentCommentId;
      })
    : args.comments;

  const subjectLabel = githubSubjectLabel(args.subjectKind);
  const messages = [
    formatGitHubIssueContextMessage({
      issue: args.issue,
      subjectLabel,
      relativeIndex: -relevantComments.length - 1,
    }),
    ...relevantComments.map((comment, index) => {
      return formatGitHubCommentContextMessage({
        comment,
        relativeIndex: index - relevantComments.length,
      });
    }),
  ];

  const parts: string[] = [
    `# GitHub ${subjectLabel} Context`,
    "",
    `Repository: ${args.repo}`,
    `${subjectLabel}: #${args.issue.number}`,
    `${subjectLabel} URL: ${githubSubjectUrl({
      repo: args.repo,
      issueNumber: args.issue.number,
      subjectKind: args.subjectKind,
    })}`,
    `Matched automation: ${args.automationDescription ?? "GitHub event"}`,
    "",
    "The messages below are from the GitHub issue conversation. Messages closer to RELATIVE_INDEX 0 are more recent.",
    "",
    messages.join("\n\n"),
    "",
    "---",
  ];
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

async function loadActiveInstallation(args: {
  readonly db: Db;
  readonly ghInstallationId: string;
  readonly signal: AbortSignal;
}): Promise<GitHubInstallationRecord> {
  const installation = await findActiveInstallation(args);

  if (!installation) {
    throw new Error(
      `GitHub installation not found: installationId=${args.ghInstallationId}`,
    );
  }

  return installation;
}

async function findActiveInstallation(args: {
  readonly db: Db;
  readonly ghInstallationId: string;
  readonly signal: AbortSignal;
}): Promise<GitHubInstallationRecord | null> {
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

  return installation ?? null;
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

async function loadGitHubRunTarget(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<GitHubRunTarget> {
  const [compose] = await args.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      orgId: agentComposes.orgId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, args.composeId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!compose) {
    throw new Error(`Agent compose not found: composeId=${args.composeId}`);
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
  };
}

async function loadGitHubAgentDisplayName(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const [agent] = await args.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, args.composeId))
    .limit(1);
  args.signal.throwIfAborted();

  return agent?.displayName ?? agent?.name ?? "this agent";
}

async function buildIssueContextForRun(args: {
  readonly token: string | undefined;
  readonly params: DispatchParams;
  readonly issueNumber: number;
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
    subjectKind: args.params.subjectKind,
    repo: args.params.repo,
    automationDescription: args.params.automationDescription,
    comments,
    currentCommentId: args.params.commentId,
  });
}

async function loadGithubUserLink(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly githubUserId: string;
  readonly signal: AbortSignal;
}): Promise<{ readonly vm0UserId: string } | null> {
  const [link] = await args.db
    .select({ vm0UserId: githubUserLinks.vm0UserId })
    .from(githubUserLinks)
    .where(
      and(
        eq(githubUserLinks.installationId, args.installationId),
        eq(githubUserLinks.githubUserId, args.githubUserId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  return link ?? null;
}

export const handleGithubIssuesEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GitHubIssuesEvent;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubLabelWorkflowAutomations$,
      {
        deliveryId: args.deliveryId,
        payload: {
          action: args.payload.action,
          issue: args.payload.issue,
          label: args.payload.label,
          repository: args.payload.repository,
          installation: args.payload.installation,
          sender: args.payload.sender,
        },
        subjectKind: "issue",
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubPullRequestEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GitHubPullRequestEvent;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubLabelWorkflowAutomations$,
      {
        deliveryId: args.deliveryId,
        payload: {
          action: args.payload.action,
          issue: args.payload.pull_request,
          label: args.payload.label,
          repository: args.payload.repository,
          installation: args.payload.installation,
          sender: args.payload.sender,
        },
        subjectKind: "pull_request",
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubWorkflowRunEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubWorkflowRunEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWorkflowRunAutomations$,
      {
        deliveryId: args.deliveryId,
        payload: args.payload,
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubWorkflowJobEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubWorkflowJobEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-workflow-job-completed",
          webhookEvent: "workflow_job",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubPullRequestReviewEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubPullRequestReviewEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-pull-request-review-submitted",
          webhookEvent: "pull_request_review",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
  },
);

export const handleGithubDeploymentStatusEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GithubDeploymentStatusEventPayload;
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-deployment-status-created",
          webhookEvent: "deployment_status",
          payload: args.payload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
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
      readonly deliveryId: string;
      readonly apiStartTime: number;
      readonly backgroundScheduledAt: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { payload } = args;
    await set(
      dispatchGithubWebhookAutomations$,
      {
        deliveryId: args.deliveryId,
        event: {
          eventType: "github-issue-comment-created",
          webhookEvent: "issue_comment",
          payload: payload as GithubIssueCommentEventPayload,
        },
        apiStartTime: args.apiStartTime,
        backgroundScheduledAt: args.backgroundScheduledAt,
      },
      signal,
    );
    signal.throwIfAborted();

    if (payload.action !== "created") {
      L.debug("Ignoring GitHub issue_comment event", {
        action: payload.action,
      });
      return;
    }

    if (payload.sender.type === "Bot" || payload.comment.user.type === "Bot") {
      L.debug("Ignoring GitHub bot issue_comment event", {
        sender: payload.sender.login,
        commentUser: payload.comment.user.login,
      });
      return;
    }

    const db = set(writeDb$);
    if (!githubCommentMentionsBot(payload.comment.body)) {
      L.debug("Ignoring GitHub issue_comment without bot mention", {
        commentId: payload.comment.id,
      });
      return;
    }

    const installation = await findActiveInstallation({
      db,
      ghInstallationId: String(payload.installation.id),
      signal,
    });
    if (!installation) {
      L.debug("Ignoring GitHub issue_comment for unbound installation", {
        action: payload.action,
        installationId: String(payload.installation.id),
        repo: payload.repository.full_name,
        commentId: payload.comment.id,
      });
      return;
    }
    const token = await getGitHubTokenForInstallation({ installation, signal });
    signal.throwIfAborted();

    const githubUserId = String(payload.sender.id);
    const link = await loadGithubUserLink({
      db,
      installationId: installation.id,
      githubUserId,
      signal,
    });
    signal.throwIfAborted();

    if (!link) {
      if (!token) {
        return;
      }

      const agentName = await loadGitHubAgentDisplayName({
        db,
        composeId: installation.defaultComposeId,
        signal,
      });
      const connectUrl = buildGithubMentionConnectUrl({
        ghInstallationId: String(payload.installation.id),
        githubUserId,
        githubUsername: payload.sender.login,
      });
      await postGithubIssueCommentBestEffort({
        token,
        repo: payload.repository.full_name,
        issueNumber: payload.issue.number,
        body: formatGithubConnectPrompt({ agentName, connectUrl }),
        signal,
      });
      signal.throwIfAborted();
      return;
    }

    const prompt =
      stripGithubBotMention(payload.comment.body) ||
      payload.comment.body.trim() ||
      payload.issue.title;

    await set(
      dispatchGithubAgentRun$,
      {
        ghInstallationId: String(payload.installation.id),
        repo: payload.repository.full_name,
        issue: payload.issue,
        subjectKind: githubIssueCommentSubjectKind(payload.issue),
        vm0UserId: link.vm0UserId,
        composeId: installation.defaultComposeId,
        prompt,
        automationDescription: `${githubAppBotUsername() ?? "GitHub App"} mention`,
        commentId: String(payload.comment.id),
        comment: payload.comment,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

async function insertGitHubChatInput(args: {
  readonly db: Db;
  readonly route: GitHubChatThreadRouteBinding;
  readonly params: DispatchParams;
  readonly target: GitHubRunTarget;
  readonly prompt: string;
  readonly issueContext: string;
  readonly reactionId: string | undefined;
  readonly currentTime: Date;
}): Promise<{ readonly chatEventId: string; readonly inserted: boolean }> {
  const issueNumber = args.params.issue.number;
  const encryptedParams = await encryptQueuedUserMessageRunParams(
    { version: 1 },
    { orgId: args.target.orgId, userId: args.params.vm0UserId },
  );

  const chatEventId = uuidv5(
    [
      args.route.installationId,
      args.params.repo,
      issueNumber,
      args.params.vm0UserId,
      args.params.commentId ?? args.params.prompt,
    ].join(":"),
    GITHUB_CHAT_MESSAGE_ID_NAMESPACE,
  );
  const inserted = await args.db.transaction(async (tx) => {
    const event = await insertChatEvent(
      tx,
      {
        id: chatEventId,
        chatThreadId: args.route.chatThreadId,
        eventType: "input.prompt",
        userMessage: createUserMessageDocument({
          text: args.prompt,
          nonContentPart: createChatEventSourcePart({
            kind: "github",
            repo: args.params.repo,
            subjectNumber: issueNumber,
            subjectKind: args.params.subjectKind,
            triggerCommentId: args.params.commentId ?? null,
          }),
        }),
        runId: null,
        triggerSource: "github",
        encryptedParams,
        githubContext: {
          repo: args.params.repo,
          subjectNumber: issueNumber,
          subjectKind: args.params.subjectKind,
          triggerCommentId: args.params.commentId ?? null,
          issueContext: args.issueContext,
          messageText: args.prompt,
          triggerReactionId: args.reactionId ?? null,
          triggerCommentBody: args.params.comment?.body ?? null,
        },
        createdAt: args.currentTime,
      },
      "id",
    );
    if (!event) {
      return false;
    }
    await tx
      .update(githubChatThreadRoutes)
      .set({
        lastCommentId: args.params.commentId ?? null,
        updatedAt: args.currentTime,
      })
      .where(eq(githubChatThreadRoutes.id, args.route.id));
    await touchChatThreadLastMessageAt(
      tx,
      args.route.chatThreadId,
      args.currentTime,
      chatEventId,
    );
    return true;
  });
  return { chatEventId, inserted };
}

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

    const target = await loadGitHubRunTarget({
      db,
      composeId: params.composeId,
      signal,
    });
    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      {
        orgId: target.orgId,
        userId: params.vm0UserId,
      },
      signal,
    );
    signal.throwIfAborted();

    const currentTime = new Date(params.apiStartTime);
    const route = await ensureGitHubChatThreadRoute(db, {
      installationId: installation.id,
      repo: params.repo,
      subjectNumber: issueNumber,
      userId: params.vm0UserId,
      orgId: target.orgId,
      agentComposeId: target.composeId,
      selectedModel: modelRoute?.selectedModel ?? null,
      currentTime,
    });
    signal.throwIfAborted();
    if (params.commentId && route.lastCommentId === params.commentId) {
      return;
    }

    const prompt = replaceGithubFileReferencesForContext(params.prompt);
    signal.throwIfAborted();
    const issueContext = await buildIssueContextForRun({
      token,
      params,
      issueNumber,
      signal,
    });
    const reactionId = await maybeAddCommentReaction({
      token,
      repo: params.repo,
      commentId: params.commentId,
      signal,
    });
    signal.throwIfAborted();

    const { chatEventId, inserted } = await insertGitHubChatInput({
      db,
      route,
      params,
      target,
      prompt,
      issueContext,
      reactionId,
      currentTime,
    });
    signal.throwIfAborted();

    if (!inserted) {
      if (token && params.commentId && reactionId) {
        await removeGithubCommentReaction({
          token,
          repo: params.repo,
          commentId: params.commentId,
          reactionId,
          signal,
        });
      }
      return;
    }

    await publishChatThreadMessageCreatedSafely(
      params.vm0UserId,
      route.chatThreadId,
    );
    signal.throwIfAborted();
    await publishThreadListChanged(params.vm0UserId);
    signal.throwIfAborted();
    await set(
      drainChatThreadQueueForThread$,
      {
        chatThreadId: route.chatThreadId,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();

    L.debug("GitHub comment queued on canonical chat thread", {
      chatThreadId: route.chatThreadId,
      chatEventId,
      repo: params.repo,
      issueNumber,
      subjectKind: params.subjectKind,
      userId: params.vm0UserId,
    });
  },
);

async function loadGithubChangedUserIds(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly orgId: string;
  readonly signal: AbortSignal;
}): Promise<readonly string[]> {
  const links = await args.db
    .select({ userId: githubUserLinks.vm0UserId })
    .from(githubUserLinks)
    .where(eq(githubUserLinks.installationId, args.installationId));
  args.signal.throwIfAborted();

  const admins = await args.db
    .select({ userId: orgMembersCache.userId })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.role, "admin"),
      ),
    );
  args.signal.throwIfAborted();

  return Array.from(
    new Set(
      [...links, ...admins].map((row) => {
        return row.userId;
      }),
    ),
  );
}

async function cleanupDeletedGithubInstallation(args: {
  readonly db: Db;
  readonly ghInstallationId: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  const [installation] = await args.db
    .select({ id: githubInstallations.id, orgId: githubInstallations.orgId })
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, args.ghInstallationId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!installation) {
    L.debug("No GitHub installation found for deleted event", {
      installationId: args.ghInstallationId,
    });
    return false;
  }

  const userIds = await loadGithubChangedUserIds({
    db: args.db,
    installationId: installation.id,
    orgId: installation.orgId,
    signal: args.signal,
  });

  await args.db
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, installation.id));
  args.signal.throwIfAborted();

  if (userIds.length > 0) {
    await publishUserSignal(userIds, "github:changed");
    args.signal.throwIfAborted();
  }

  L.debug("Cleaned up deleted GitHub installation", {
    installationId: args.ghInstallationId,
    recordId: installation.id,
  });
  return true;
}

export const handleGithubInstallationEvent$ = command(
  async (
    { set },
    payload: GitHubInstallationEvent,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const ghInstallationId = String(payload.installation.id);

    if (payload.action === "deleted") {
      await cleanupDeletedGithubInstallation({
        db,
        ghInstallationId,
        signal,
      });
      return;
    }

    if (payload.action !== "created") {
      L.debug("Ignoring installation event", { action: payload.action });
      return;
    }

    L.debug("Ignoring GitHub installation created event", {
      installationId: ghInstallationId,
      targetId: String(payload.installation.account.id),
    });
  },
);
