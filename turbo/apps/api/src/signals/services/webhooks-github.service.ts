import { randomBytes } from "node:crypto";

import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import {
  githubIssuesCallbackPayloadSchema,
  type GitHubIssuesCallbackPayload,
} from "@vm0/api-contracts/contracts/internal-callbacks-github-issues";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { githubLabelListeners } from "@vm0/db/schema/github-label-listener";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command, type Setter } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
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
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { createZeroRun$ } from "./zero-runs-create.service";

const L = logger("WebhookGithub");
const RUN_START_FALLBACK_MESSAGE =
  "An unexpected error occurred. Please try again later.";
const GITHUB_ALIAS_MENTION_HANDLES = ["@Zero[bot]", "@Zero"] as const;

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
  pull_request: z.unknown().optional(),
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

export const gitHubPullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: gitHubIssueSchema,
  label: gitHubLabelSchema.optional(),
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
type GitHubPullRequestEvent = z.infer<typeof gitHubPullRequestEventSchema>;
type GitHubInstallationEvent = z.infer<typeof gitHubInstallationEventSchema>;
type GitHubInstallationRecord = typeof githubInstallations.$inferSelect;
type GitHubLabelListenerRecord = typeof githubLabelListeners.$inferSelect;
type GitHubTriggerKind = "issue" | "pull_request";

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
  readonly subjectKind: GitHubTriggerKind;
  readonly vm0UserId: string;
  readonly composeId: string;
  readonly prompt: string;
  readonly matchedLabelName?: string;
  readonly triggerDescription?: string;
  readonly commentId?: string;
  readonly comment?: GitHubComment;
  readonly apiStartTime: number;
}

type ExistingSessionResult =
  | { readonly kind: "duplicate" }
  | {
      readonly kind: "resolved";
      readonly sessionId: string | undefined;
    };

interface GitHubRunTarget {
  readonly composeId: string;
  readonly orgId: string;
  readonly zeroAgentId: string;
}

interface GitHubRunDispatchResult {
  readonly status: "accepted" | "queued" | "failed";
  readonly runId?: string;
  readonly response?: string;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function githubSubjectLabel(subjectKind: GitHubTriggerKind): string {
  return subjectKind === "pull_request" ? "Pull Request" : "Issue";
}

function githubSubjectUrl(args: {
  readonly repo: string;
  readonly issueNumber: number;
  readonly subjectKind: GitHubTriggerKind;
}): string {
  const pathSegment = args.subjectKind === "pull_request" ? "pull" : "issues";
  return `https://github.com/${args.repo}/${pathSegment}/${args.issueNumber}`;
}

function githubAppBotUsername(): string | undefined {
  const appSlug = optionalEnv("GITHUB_APP_SLUG")?.trim();
  if (!appSlug) {
    return undefined;
  }
  return `@${appSlug}[bot]`;
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

function githubIssueCommentSubjectKind(issue: GitHubIssue): GitHubTriggerKind {
  return issue.pull_request === undefined ? "issue" : "pull_request";
}

function buildIntegrationPrompt(): string {
  const headerParts = [
    "# Current Integration",
    "You are currently running inside: GitHub",
    "GitHub label listeners run agents when issues or pull requests receive matching labels. Manage them with `zero github label-listener -h`.",
  ];
  const botUsername = githubAppBotUsername();
  if (botUsername) {
    headerParts.push(`Bot username: ${botUsername}`);
  }
  return headerParts.join("\n");
}

function buildGitHubPrompt(args: {
  readonly issueContext: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly subjectKind: GitHubTriggerKind;
}): string {
  return [buildIntegrationPrompt(), args.issueContext]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

function normalizeLabelName(labelName: string): string {
  return labelName.trim().toLowerCase();
}

function buildPromptParts(
  prompt: string,
  args: {
    readonly issueContext: string;
    readonly repo: string;
    readonly issueNumber: number;
    readonly subjectKind: GitHubTriggerKind;
  },
): {
  readonly prompt: string;
  readonly appendSystemPrompt: string | undefined;
} {
  const appendSystemPrompt = buildGitHubPrompt(args) || undefined;

  return { prompt, appendSystemPrompt };
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
  readonly subjectKind: GitHubTriggerKind;
  readonly repo: string;
  readonly matchedLabelName: string | undefined;
  readonly triggerDescription: string | undefined;
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
    args.matchedLabelName
      ? `Matched label: ${args.matchedLabelName}`
      : `Matched trigger: ${args.triggerDescription ?? "GitHub event"}`,
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
  readonly modelRoute: IntegrationModelRoutePin | undefined;
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
    return { kind: "resolved", sessionId: undefined };
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
  if (!sessionId) {
    return {
      kind: "resolved",
      sessionId: undefined,
    };
  }

  if (
    !(await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId,
      modelRoute: args.modelRoute,
    }))
  ) {
    return {
      kind: "resolved",
      sessionId: undefined,
    };
  }

  return {
    kind: "resolved",
    sessionId,
  };
}

function routeErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const error = body.error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }
  const message = error.message;
  if (typeof message !== "string") {
    return undefined;
  }
  const code =
    "code" in error && typeof error.code === "string"
      ? error.code
      : "INTERNAL_SERVER_ERROR";
  return formatRunErrorForExternalSurface({ code, message });
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

async function handleDispatchError(args: {
  readonly message: string | undefined;
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
    const message = args.message ?? RUN_START_FALLBACK_MESSAGE;
    await postGithubIssueCommentBestEffort({
      token: args.token,
      repo: args.repo,
      issueNumber: args.issueNumber,
      body: `${quotePrefix}${message}`,
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
    zeroAgentId: agent.id,
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
    matchedLabelName: args.params.matchedLabelName,
    triggerDescription: args.params.triggerDescription,
    comments,
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

async function runAgentForGitHub(args: {
  readonly set: Setter;
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly sessionId: string | undefined;
  readonly prompt: string;
  readonly appendSystemPrompt: string | undefined;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
  readonly callbackPayload: GitHubIssuesCallbackPayload;
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}): Promise<GitHubRunDispatchResult> {
  const result = await args.set(
    createZeroRun$,
    {
      auth: {
        tokenType: "session",
        userId: args.userId,
        orgId: args.orgId,
        orgRole: "member",
      },
      body: {
        prompt: args.prompt,
        agentId: args.agentId,
        sessionId: args.sessionId,
        ...(args.modelRoute?.modelProviderType
          ? { modelProvider: args.modelRoute.modelProviderType }
          : {}),
      },
      apiStartTime: args.apiStartTime,
      triggerSource: "github",
      appendSystemPrompt: args.appendSystemPrompt,
      modelProviderId: args.modelRoute?.modelProviderId ?? undefined,
      modelProviderCredentialScope:
        args.modelRoute?.modelProviderCredentialScope,
      selectedModelOverride: args.modelRoute?.selectedModel,
      callbacks: [
        {
          url: `${env("VM0_API_URL")}/api/internal/callbacks/github/issues`,
          secret: generateCallbackSecret(),
          payload: args.callbackPayload,
        },
      ],
    },
    args.signal,
  );
  args.signal.throwIfAborted();

  if (result.status !== 201) {
    return {
      status: "failed",
      response: routeErrorMessage(result.body) ?? RUN_START_FALLBACK_MESSAGE,
    };
  }

  const status = stringField(result.body, "status");
  const runId = stringField(result.body, "runId");
  if (status === "queued") {
    return { status: "queued", runId };
  }
  if (status === "failed") {
    return {
      status: "failed",
      runId,
      response: stringField(result.body, "error") ?? RUN_START_FALLBACK_MESSAGE,
    };
  }
  return { status: "accepted", runId };
}

function labelsForAction(args: {
  readonly action: string;
  readonly labels: readonly z.infer<typeof gitHubLabelSchema>[];
  readonly label: z.infer<typeof gitHubLabelSchema> | undefined;
}): readonly string[] {
  if (args.action === "labeled") {
    return args.label ? [args.label.name] : [];
  }

  if (args.action === "opened") {
    return args.labels.map((label) => {
      return label.name;
    });
  }

  return [];
}

async function loadMatchingLabelListener(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly labelNames: readonly string[];
  readonly signal: AbortSignal;
}): Promise<GitHubLabelListenerRecord | null> {
  const normalizedLabels = new Set(
    args.labelNames.map((labelName) => {
      return normalizeLabelName(labelName);
    }),
  );
  if (normalizedLabels.size === 0) {
    return null;
  }

  const listeners = await args.db
    .select()
    .from(githubLabelListeners)
    .where(
      and(
        eq(githubLabelListeners.installationId, args.installationId),
        eq(githubLabelListeners.enabled, true),
      ),
    )
    .orderBy(asc(githubLabelListeners.createdAt));
  args.signal.throwIfAborted();

  return (
    listeners.find((listener) => {
      return normalizedLabels.has(listener.labelNameNormalized);
    }) ?? null
  );
}

async function issueAuthorMatchesListenerCreator(args: {
  readonly db: Db;
  readonly listener: GitHubLabelListenerRecord;
  readonly authorGithubUserId: string;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  if (args.listener.triggerMode !== "created_by_me") {
    return true;
  }

  const [link] = await args.db
    .select({ githubUserId: githubUserLinks.githubUserId })
    .from(githubUserLinks)
    .where(
      and(
        eq(githubUserLinks.installationId, args.listener.installationId),
        eq(githubUserLinks.vm0UserId, args.listener.createdByUserId),
      ),
    )
    .limit(1);
  args.signal.throwIfAborted();

  return link?.githubUserId === args.authorGithubUserId;
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

interface LabelTriggerEventParams {
  readonly payload: {
    readonly action: string;
    readonly issue: GitHubIssue;
    readonly label: z.infer<typeof gitHubLabelSchema> | undefined;
    readonly repository: z.infer<typeof gitHubRepositorySchema>;
    readonly installation: z.infer<typeof gitHubInstallationRefSchema>;
  };
  readonly subjectKind: GitHubTriggerKind;
  readonly apiStartTime: number;
}

const dispatchMatchingLabelListener$ = command(
  async (
    { set },
    args: LabelTriggerEventParams,
    signal: AbortSignal,
  ): Promise<void> => {
    const { action, issue, label, repository, installation } = args.payload;
    if (action !== "opened" && action !== "labeled") {
      L.debug("Ignoring GitHub label trigger event", { action });
      return;
    }

    const labelNames = labelsForAction({ action, labels: issue.labels, label });
    const db = set(writeDb$);
    const installationRecord = await loadActiveInstallation({
      db,
      ghInstallationId: String(installation.id),
      signal,
    });
    const listener = await loadMatchingLabelListener({
      db,
      installationId: installationRecord.id,
      labelNames,
      signal,
    });
    signal.throwIfAborted();

    if (!listener) {
      L.debug("Ignoring GitHub event without a matching label listener", {
        action,
        labels: labelNames,
      });
      return;
    }

    if (
      !(await issueAuthorMatchesListenerCreator({
        db,
        listener,
        authorGithubUserId: String(issue.user.id),
        signal,
      }))
    ) {
      L.debug("Ignoring GitHub event because trigger mode requires creator", {
        listenerId: listener.id,
        triggerMode: listener.triggerMode,
        issueAuthorGithubUserId: issue.user.id,
      });
      return;
    }

    await set(
      dispatchGithubAgentRun$,
      {
        ghInstallationId: String(installation.id),
        repo: repository.full_name,
        issue,
        subjectKind: args.subjectKind,
        vm0UserId: listener.createdByUserId,
        composeId: listener.composeId,
        prompt: listener.prompt,
        matchedLabelName: listener.labelName,
        apiStartTime: args.apiStartTime,
      },
      signal,
    );
  },
);

export const handleGithubIssuesEvent$ = command(
  async (
    { set },
    args: {
      readonly payload: GitHubIssuesEvent;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchMatchingLabelListener$,
      {
        payload: {
          action: args.payload.action,
          issue: args.payload.issue,
          label: args.payload.label,
          repository: args.payload.repository,
          installation: args.payload.installation,
        },
        subjectKind: "issue",
        apiStartTime: args.apiStartTime,
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
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      dispatchMatchingLabelListener$,
      {
        payload: {
          action: args.payload.action,
          issue: args.payload.pull_request,
          label: args.payload.label,
          repository: args.payload.repository,
          installation: args.payload.installation,
        },
        subjectKind: "pull_request",
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
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { payload } = args;
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

    if (!githubCommentMentionsBot(payload.comment.body)) {
      L.debug("Ignoring GitHub issue_comment without bot mention", {
        commentId: payload.comment.id,
      });
      return;
    }

    const db = set(writeDb$);
    const installation = await loadActiveInstallation({
      db,
      ghInstallationId: String(payload.installation.id),
      signal,
    });
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
        triggerDescription: `${githubAppBotUsername() ?? "GitHub App"} mention`,
        commentId: String(payload.comment.id),
        comment: payload.comment,
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

    const sessionResult = await resolveExistingSession({
      db,
      installationDbId: installation.id,
      repo: params.repo,
      issueNumber,
      composeId: target.composeId,
      vm0UserId: params.vm0UserId,
      commentId: params.commentId,
      modelRoute,
      signal,
    });
    if (sessionResult.kind === "duplicate") {
      return;
    }

    const existingSessionId = sessionResult.sessionId;
    const prompt = replaceGithubFileReferencesForContext(params.prompt);
    signal.throwIfAborted();
    const issueContext = await buildIssueContextForRun({
      token,
      params,
      issueNumber,
      signal,
    });
    const promptParts = buildPromptParts(prompt, {
      issueContext,
      repo: params.repo,
      issueNumber,
      subjectKind: params.subjectKind,
    });

    const callbackPayload = buildCallbackPayload({
      installationDbId: installation.id,
      params,
      issueNumber,
      composeId: target.composeId,
      existingSessionId,
      reactionId,
    });

    const dispatchResult = await runAgentForGitHub({
      set,
      userId: params.vm0UserId,
      orgId: target.orgId,
      agentId: target.zeroAgentId,
      sessionId: existingSessionId,
      prompt: promptParts.prompt,
      appendSystemPrompt: promptParts.appendSystemPrompt,
      modelRoute,
      callbackPayload,
      apiStartTime: params.apiStartTime,
      signal,
    });

    if (dispatchResult.status === "failed") {
      if (!dispatchResult.runId) {
        await handleDispatchError({
          message: dispatchResult.response,
          token,
          repo: params.repo,
          issueNumber,
          commentId: params.commentId,
          reactionId,
          commentBody: params.comment?.body,
          signal,
        });
        signal.throwIfAborted();
      }
      return;
    }

    L.debug("Agent run dispatched for GitHub issue", {
      runId: dispatchResult.runId,
      status: dispatchResult.status,
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
