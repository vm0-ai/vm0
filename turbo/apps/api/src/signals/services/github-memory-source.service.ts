import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import {
  memoryContentHash,
  recordMemorySource,
} from "./memory-substrate.service";
import { enqueueMemorySourceRelationshipExtractionJob } from "./relationship-memory-gmail-queue.service";
import { recordMemoryDocumentFromConnectorSource } from "./zero-memory-document-ingestion.service";

type GithubSubjectKind = "issue" | "pull_request";

interface GithubUser {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

interface GithubLabel {
  readonly name: string;
}

interface GithubIssueLike {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly labels: readonly GithubLabel[];
  readonly user: GithubUser;
}

interface GithubRepository {
  readonly full_name: string;
}

interface GithubInstallationRef {
  readonly id: number;
}

interface GithubCommentLike {
  readonly id: number;
  readonly body: string;
  readonly html_url?: string;
  readonly created_at?: string;
  readonly user: GithubUser;
}

type GithubInstallationRecord = typeof githubInstallations.$inferSelect;

interface ResolvedGithubInstallation {
  readonly id: string;
  readonly orgId: string;
  readonly remoteInstallationId: string;
  readonly repoConfigs?: GithubInstallationRecord["repoConfigs"];
}

const githubTrustedContributorSchema = z.object({
  githubUserId: z.string().optional(),
  login: z.string().optional(),
  email: z.string().optional(),
});

const githubMemoryRepositoryConfigSchema = z.object({
  fullName: z.string(),
  selected: z.boolean(),
  includeIssues: z.boolean().optional(),
  includePullRequests: z.boolean().optional(),
  includeComments: z.boolean().optional(),
  trustedContributors: z.array(githubTrustedContributorSchema).default([]),
});

const githubRepoConfigsSchema = z
  .object({
    memory: z
      .object({
        users: z
          .record(
            z.string(),
            z.object({
              repositories: z.array(githubMemoryRepositoryConfigSchema),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .default({});

type GithubMemoryRepositoryConfig = z.infer<
  typeof githubMemoryRepositoryConfigSchema
>;

function parsedDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function githubSubjectUrl(args: {
  readonly repo: string;
  readonly subjectKind: GithubSubjectKind;
  readonly subjectNumber: number;
}): string {
  const pathSegment = args.subjectKind === "pull_request" ? "pull" : "issues";
  return `https://github.com/${args.repo}/${pathSegment}/${args.subjectNumber}`;
}

function githubSubjectExternalId(args: {
  readonly installationId: string;
  readonly repo: string;
  readonly subjectKind: GithubSubjectKind;
  readonly subjectNumber: number;
}): string {
  return [
    args.installationId,
    args.repo,
    args.subjectKind,
    String(args.subjectNumber),
  ].join(":");
}

function githubCommentExternalId(args: {
  readonly installationId: string;
  readonly repo: string;
  readonly commentId: number;
}): string {
  return [args.installationId, args.repo, "issue_comment", args.commentId].join(
    ":",
  );
}

function githubSubjectSourceType(
  subjectKind: GithubSubjectKind,
): "github_pull_request" | "github_issue" {
  return subjectKind === "pull_request"
    ? "github_pull_request"
    : "github_issue";
}

function githubRepoContextSpace(repo: string) {
  return {
    type: "repo" as const,
    key: `github:${repo.toLowerCase()}`,
    displayName: repo,
    metadata: {
      provider: "github",
      externalId: repo,
      displayName: repo,
      reason: "GitHub repository memory context",
    },
  };
}

function githubLabelNames(issue: GithubIssueLike): readonly string[] {
  return issue.labels.map((label) => {
    return label.name;
  });
}

function githubSubjectMemoryMetadata(args: {
  readonly installation: ResolvedGithubInstallation;
  readonly issue: GithubIssueLike;
  readonly repository: GithubRepository;
  readonly sender: GithubUser;
  readonly subjectKind: GithubSubjectKind;
  readonly subjectUrl: string;
  readonly reason: string;
}) {
  return {
    githubInstallationId: args.installation.id,
    githubRemoteInstallationId: args.installation.remoteInstallationId,
    githubRepository: args.repository.full_name,
    githubSubjectKind: args.subjectKind,
    githubSubjectNumber: args.issue.number,
    githubSubjectUrl: args.subjectUrl,
    githubActorId: String(args.sender.id),
    githubActorLogin: args.sender.login,
    githubAuthorId: String(args.issue.user.id),
    githubAuthorLogin: args.issue.user.login,
    githubLabels: githubLabelNames(args.issue),
    direction: "sent" as const,
    reason: args.reason,
  };
}

function githubSubjectDocumentContent(args: {
  readonly issue: GithubIssueLike;
  readonly repository: GithubRepository;
  readonly subjectKind: GithubSubjectKind;
  readonly subjectUrl: string;
}): string {
  return [
    `# ${args.issue.title}`,
    "",
    `Repository: ${args.repository.full_name}`,
    `Kind: ${args.subjectKind}`,
    `Number: #${args.issue.number}`,
    `URL: ${args.subjectUrl}`,
    args.issue.labels.length > 0
      ? `Labels: ${args.issue.labels
          .map((label) => {
            return label.name;
          })
          .join(", ")}`
      : null,
    "",
    args.issue.body ?? "",
  ]
    .filter((line): line is string => {
      return line !== null;
    })
    .join("\n");
}

function githubCommentDocumentContent(args: {
  readonly issue: GithubIssueLike;
  readonly comment: GithubCommentLike;
  readonly repository: GithubRepository;
  readonly subjectKind: GithubSubjectKind;
  readonly commentUrl: string | null;
}): string {
  return [
    `# ${args.issue.title}`,
    "",
    `Repository: ${args.repository.full_name}`,
    `Kind: ${args.subjectKind} comment`,
    `Number: #${args.issue.number}`,
    args.commentUrl ? `URL: ${args.commentUrl}` : null,
    `Author: ${args.comment.user.login}`,
    "",
    args.comment.body,
  ]
    .filter((line): line is string => {
      return line !== null;
    })
    .join("\n");
}

async function recordGithubSubjectMemoryDocument(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly externalId: string;
  readonly issue: GithubIssueLike;
  readonly repository: GithubRepository;
  readonly subjectKind: GithubSubjectKind;
  readonly subjectUrl: string;
  readonly occurredAt: Date;
  readonly reason: string;
}): Promise<void> {
  const sourceType = githubSubjectSourceType(args.subjectKind);
  await recordMemoryDocumentFromConnectorSource(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "github",
    sourceType,
    externalId: args.externalId,
    title: args.issue.title,
    content: githubSubjectDocumentContent({
      issue: args.issue,
      repository: args.repository,
      subjectKind: args.subjectKind,
      subjectUrl: args.subjectUrl,
    }),
    occurredAt: args.occurredAt,
    contextSpace: githubRepoContextSpace(args.repository.full_name),
    metadata: {
      provider: "github",
      sourceType,
      externalUrl: args.subjectUrl,
      repository: args.repository.full_name,
      subjectKind: args.subjectKind,
      subjectNumber: args.issue.number,
      reason: args.reason,
    },
    citation: {
      url: args.subjectUrl,
      locator: `#${args.issue.number}`,
    },
  });
}

async function findActiveGithubInstallation(args: {
  readonly db: Db;
  readonly ghInstallationId: string;
}): Promise<ResolvedGithubInstallation | null> {
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
  return installation?.installationId
    ? {
        id: installation.id,
        orgId: installation.orgId,
        remoteInstallationId: installation.installationId,
        repoConfigs: installation.repoConfigs,
      }
    : null;
}

async function loadGithubLinkedUser(args: {
  readonly db: Db;
  readonly installationId: string;
  readonly githubUserId: string;
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
  return link ?? null;
}

async function enqueueGithubSourceExtraction(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly externalId: string;
  readonly reason: string;
}): Promise<boolean> {
  return await enqueueMemorySourceRelationshipExtractionJob(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    provider: "github",
    sourceExternalId: args.externalId,
    reason: args.reason,
    priority: 30,
    replaceExisting: true,
  });
}

function configuredRepositoryForUser(args: {
  readonly installation: ResolvedGithubInstallation;
  readonly userId: string;
  readonly repo: string;
}): GithubMemoryRepositoryConfig | null {
  const parsed = githubRepoConfigsSchema.safeParse(
    args.installation.repoConfigs ?? {},
  );
  if (!parsed.success) {
    return null;
  }
  const repositories =
    parsed.data.memory?.users?.[args.userId]?.repositories ?? [];
  const normalizedRepo = args.repo.toLowerCase();
  return (
    repositories.find((repository) => {
      return (
        repository.selected &&
        repository.fullName.toLowerCase() === normalizedRepo
      );
    }) ?? null
  );
}

function githubActorIsTrusted(args: {
  readonly repository: GithubMemoryRepositoryConfig;
  readonly actor: GithubUser;
}): boolean {
  const githubUserId = String(args.actor.id);
  const login = args.actor.login.trim().toLowerCase();
  return args.repository.trustedContributors.some((contributor) => {
    return (
      contributor.githubUserId === githubUserId ||
      contributor.login?.trim().toLowerCase() === login
    );
  });
}

function repositoryAllowsSubject(args: {
  readonly repository: GithubMemoryRepositoryConfig;
  readonly subjectKind: GithubSubjectKind;
}): boolean {
  return args.subjectKind === "pull_request"
    ? args.repository.includePullRequests !== false
    : args.repository.includeIssues !== false;
}

function repositoryAllowsComment(
  repository: GithubMemoryRepositoryConfig,
): boolean {
  return repository.includeComments !== false;
}

async function resolveGithubMemoryTarget(args: {
  readonly db: Db;
  readonly installation: ResolvedGithubInstallation;
  readonly actor: GithubUser;
  readonly targetUserId?: string;
  readonly repository: GithubRepository;
  readonly subjectKind: GithubSubjectKind;
  readonly comment: boolean;
}): Promise<{ readonly userId: string } | null> {
  if (args.targetUserId) {
    return { userId: args.targetUserId };
  }

  const link = await loadGithubLinkedUser({
    db: args.db,
    installationId: args.installation.id,
    githubUserId: String(args.actor.id),
  });
  if (!link) {
    return null;
  }

  const repository = configuredRepositoryForUser({
    installation: args.installation,
    userId: link.vm0UserId,
    repo: args.repository.full_name,
  });
  if (!repository) {
    return null;
  }
  if (
    !repositoryAllowsSubject({
      repository,
      subjectKind: args.subjectKind,
    }) ||
    (args.comment && !repositoryAllowsComment(repository)) ||
    !githubActorIsTrusted({ repository, actor: args.actor })
  ) {
    return null;
  }

  return { userId: link.vm0UserId };
}

export async function recordGithubSubjectMemorySource(args: {
  readonly db: Db;
  readonly targetUserId?: string;
  readonly installationRecord?: ResolvedGithubInstallation;
  readonly action: string;
  readonly issue: GithubIssueLike;
  readonly repository: GithubRepository;
  readonly installation: GithubInstallationRef;
  readonly sender: GithubUser;
  readonly subjectKind: GithubSubjectKind;
  readonly reason: string;
}): Promise<boolean> {
  if (args.sender.type === "Bot") {
    return false;
  }

  const installation =
    args.installationRecord ??
    (await findActiveGithubInstallation({
      db: args.db,
      ghInstallationId: String(args.installation.id),
    }));
  if (!installation) {
    return false;
  }

  const target = await resolveGithubMemoryTarget({
    db: args.db,
    installation,
    actor: args.sender,
    targetUserId: args.targetUserId,
    repository: args.repository,
    subjectKind: args.subjectKind,
    comment: false,
  });
  if (!target) {
    return false;
  }

  const externalId = githubSubjectExternalId({
    installationId: installation.id,
    repo: args.repository.full_name,
    subjectKind: args.subjectKind,
    subjectNumber: args.issue.number,
  });
  const subjectUrl =
    args.issue.html_url ??
    githubSubjectUrl({
      repo: args.repository.full_name,
      subjectKind: args.subjectKind,
      subjectNumber: args.issue.number,
    });
  const contentHash = memoryContentHash(
    [args.issue.title, args.issue.body ?? ""].join("\n"),
  );
  const occurredAt =
    parsedDate(args.issue.updated_at) ??
    parsedDate(args.issue.created_at) ??
    nowDate();
  const sourceType = githubSubjectSourceType(args.subjectKind);
  const didRecord = await recordMemorySource(args.db, {
    orgId: installation.orgId,
    userId: target.userId,
    provider: "github",
    sourceType,
    externalId,
    occurredAt,
    title: args.issue.title,
    contentHash,
    metadata: githubSubjectMemoryMetadata({
      installation,
      issue: args.issue,
      repository: args.repository,
      sender: args.sender,
      subjectKind: args.subjectKind,
      subjectUrl,
      reason: args.reason,
    }),
  });
  if (!didRecord) {
    return false;
  }

  await recordGithubSubjectMemoryDocument({
    db: args.db,
    orgId: installation.orgId,
    userId: target.userId,
    externalId,
    issue: args.issue,
    repository: args.repository,
    subjectKind: args.subjectKind,
    subjectUrl,
    occurredAt,
    reason: args.reason,
  });

  return await enqueueGithubSourceExtraction({
    db: args.db,
    orgId: installation.orgId,
    userId: target.userId,
    externalId,
    reason: args.reason,
  });
}

export async function recordGithubIssueCommentMemorySource(args: {
  readonly db: Db;
  readonly targetUserId?: string;
  readonly installationRecord?: ResolvedGithubInstallation;
  readonly issue: GithubIssueLike;
  readonly comment: GithubCommentLike;
  readonly repository: GithubRepository;
  readonly installation: GithubInstallationRef;
  readonly sender: GithubUser;
  readonly subjectKind: GithubSubjectKind;
  readonly reason: string;
}): Promise<boolean> {
  if (args.sender.type === "Bot" || args.comment.user.type === "Bot") {
    return false;
  }

  const installation =
    args.installationRecord ??
    (await findActiveGithubInstallation({
      db: args.db,
      ghInstallationId: String(args.installation.id),
    }));
  if (!installation) {
    return false;
  }

  const target = await resolveGithubMemoryTarget({
    db: args.db,
    installation,
    actor: args.comment.user,
    targetUserId: args.targetUserId,
    repository: args.repository,
    subjectKind: args.subjectKind,
    comment: true,
  });
  if (!target) {
    return false;
  }

  const externalId = githubCommentExternalId({
    installationId: installation.id,
    repo: args.repository.full_name,
    commentId: args.comment.id,
  });
  const occurredAt = parsedDate(args.comment.created_at) ?? nowDate();
  const didRecord = await recordMemorySource(args.db, {
    orgId: installation.orgId,
    userId: target.userId,
    provider: "github",
    sourceType: "github_issue_comment",
    externalId,
    occurredAt,
    title: args.issue.title,
    contentHash: memoryContentHash(args.comment.body),
    metadata: {
      githubInstallationId: installation.id,
      githubRemoteInstallationId: installation.remoteInstallationId,
      githubRepository: args.repository.full_name,
      githubSubjectKind: args.subjectKind,
      githubSubjectNumber: args.issue.number,
      githubSubjectUrl:
        args.issue.html_url ??
        githubSubjectUrl({
          repo: args.repository.full_name,
          subjectKind: args.subjectKind,
          subjectNumber: args.issue.number,
        }),
      githubIssueCommentId: String(args.comment.id),
      githubActorId: String(args.comment.user.id),
      githubActorLogin: args.comment.user.login,
      githubAuthorId: String(args.issue.user.id),
      githubAuthorLogin: args.issue.user.login,
      githubLabels: args.issue.labels.map((label) => {
        return label.name;
      }),
      threadId: String(args.issue.number),
      messageId: String(args.comment.id),
      direction: "sent",
      reason: args.reason,
    },
  });
  if (!didRecord) {
    return false;
  }

  const subjectUrl =
    args.issue.html_url ??
    githubSubjectUrl({
      repo: args.repository.full_name,
      subjectKind: args.subjectKind,
      subjectNumber: args.issue.number,
    });
  const commentUrl = args.comment.html_url ?? null;
  await recordMemoryDocumentFromConnectorSource(args.db, {
    orgId: installation.orgId,
    userId: target.userId,
    provider: "github",
    sourceType: "github_issue_comment",
    externalId,
    title: args.issue.title,
    content: githubCommentDocumentContent({
      issue: args.issue,
      comment: args.comment,
      repository: args.repository,
      subjectKind: args.subjectKind,
      commentUrl,
    }),
    occurredAt,
    contextSpace: githubRepoContextSpace(args.repository.full_name),
    metadata: {
      provider: "github",
      sourceType: "github_issue_comment",
      externalUrl: commentUrl ?? subjectUrl,
      repository: args.repository.full_name,
      subjectKind: args.subjectKind,
      subjectNumber: args.issue.number,
      reason: args.reason,
    },
    citation: {
      url: commentUrl ?? subjectUrl,
      locator: `#${args.issue.number} comment ${args.comment.id}`,
    },
  });

  return await enqueueGithubSourceExtraction({
    db: args.db,
    orgId: installation.orgId,
    userId: target.userId,
    externalId,
    reason: args.reason,
  });
}
