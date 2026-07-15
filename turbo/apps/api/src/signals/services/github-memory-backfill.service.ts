import { command } from "ccstate";
import { z } from "zod";
import type {
  GithubMemoryBackfillRequest,
  GithubMemoryConfigureRequest,
  GithubMemoryContributorsResponse,
  GithubMemoryRepositoriesResponse,
  GithubMemoryStatusResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import type {
  GitHubMemoryRepositoryConfig,
  GitHubMemoryTrustedContributorConfig,
} from "@vm0/db/jsonb-contracts/github-installation";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import {
  relationshipBackfillJobs,
  type RelationshipBackfillJobStatus,
} from "@vm0/db/schema/relationship-memory";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import { tapError } from "../utils";
import { getGithubInstallationAccessToken } from "./github-app.service";
import {
  fetchGithubInstallationRepositories,
  fetchGithubIssueComments,
  fetchGithubIssuesPage,
  fetchGithubRepositoryContributors,
  type GithubIssueComment,
  type GithubIssueDetail,
} from "./github-issues-api.service";
import {
  recordGithubIssueCommentMemorySource,
  recordGithubSubjectMemorySource,
} from "./github-memory-source.service";

const log = logger("api:github-memory-backfill");
const GITHUB_BACKFILL_PAGE_SIZE = 50;
const BACKFILL_LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_BACKFILL_JOBS_PER_DRAIN = 1;

type GithubMemoryBackfillStatus = RelationshipBackfillJobStatus | "idle";
type GithubSubjectKind = "issue" | "pull_request";

interface MemoryScope {
  readonly orgId: string;
  readonly userId: string;
}

interface GithubMemoryInstallation {
  readonly id: string;
  readonly orgId: string;
  readonly remoteInstallationId: string;
  readonly targetName: string | null;
  readonly repoConfigs: typeof githubInstallations.$inferSelect.repoConfigs;
}

interface GithubMemoryUserConfig {
  readonly repositories: readonly GitHubMemoryRepositoryConfig[];
  readonly updatedAt?: string;
}

interface GithubBackfillCursor {
  readonly repositoryIndex: number;
  readonly issuePage: number;
}

type GithubMemoryMutationResult =
  | { readonly kind: "ok"; readonly status: GithubMemoryStatusResponse }
  | { readonly kind: "bad-request"; readonly message: string };

const trustedContributorSchema = z.object({
  githubUserId: z.string().optional(),
  login: z.string().optional(),
  email: z.string().optional(),
});

const repositoryConfigSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().optional(),
  fullName: z.string().min(1),
  defaultBranch: z.string().nullable().optional(),
  selected: z.boolean(),
  includeIssues: z.boolean().optional(),
  includePullRequests: z.boolean().optional(),
  includeComments: z.boolean().optional(),
  trustedContributors: z.array(trustedContributorSchema).default([]),
});

const userConfigSchema = z.object({
  repositories: z.array(repositoryConfigSchema).default([]),
  updatedAt: z.string().optional(),
});

const repoConfigsSchema = z
  .object({
    memory: z
      .object({
        users: z.record(z.string(), userConfigSchema).optional(),
      })
      .optional(),
  })
  .default({});

const backfillOptionsSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
});

const backfillCursorSchema = z
  .object({
    repositoryIndex: z.number().int().nonnegative().default(0),
    issuePage: z.number().int().positive().default(1),
  })
  .default({ repositoryIndex: 0, issuePage: 1 });

function serializeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function parseRepoConfigs(value: unknown): z.infer<typeof repoConfigsSchema> {
  return repoConfigsSchema.parse(value ?? {});
}

function parseBackfillOptions(value: string): GithubMemoryBackfillRequest {
  return backfillOptionsSchema.parse(JSON.parse(value) as unknown);
}

function parseBackfillCursor(value: string | null): GithubBackfillCursor {
  return value
    ? backfillCursorSchema.parse(JSON.parse(value) as unknown)
    : backfillCursorSchema.parse({});
}

function serializeBackfillCursor(value: GithubBackfillCursor): string {
  return JSON.stringify(value);
}

function normalizeLogin(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || null;
}

function normalizeEmail(value: string | undefined | null): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || null;
}

function normalizeTrustedContributor(
  contributor: GitHubMemoryTrustedContributorConfig,
): GitHubMemoryTrustedContributorConfig | null {
  const githubUserId = contributor.githubUserId?.trim();
  const login = contributor.login?.trim();
  const email = normalizeEmail(contributor.email);
  if (!githubUserId && !login && !email) {
    return null;
  }
  return {
    ...(githubUserId ? { githubUserId } : {}),
    ...(login ? { login } : {}),
    ...(email ? { email } : {}),
  };
}

function normalizeRepositoryConfig(
  config: GithubMemoryConfigureRequest["repositories"][number],
): GitHubMemoryRepositoryConfig {
  return {
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.name ? { name: config.name } : {}),
    fullName: config.fullName.trim(),
    defaultBranch: config.defaultBranch ?? null,
    selected: config.selected,
    includeIssues: config.includeIssues,
    includePullRequests: config.includePullRequests,
    includeComments: config.includeComments,
    trustedContributors: config.trustedContributors.flatMap((contributor) => {
      const normalized = normalizeTrustedContributor(contributor);
      return normalized ? [normalized] : [];
    }),
  };
}

function selectedRepositories(
  config: GithubMemoryUserConfig,
): readonly GitHubMemoryRepositoryConfig[] {
  return config.repositories.filter((repository) => {
    return repository.selected;
  });
}

function configuredRepository(
  config: GithubMemoryUserConfig,
  fullName: string,
): GitHubMemoryRepositoryConfig | null {
  const normalized = fullName.toLowerCase();
  return (
    config.repositories.find((repository) => {
      return (
        repository.selected && repository.fullName.toLowerCase() === normalized
      );
    }) ?? null
  );
}

function userMemoryConfig(
  repoConfigs: typeof githubInstallations.$inferSelect.repoConfigs,
  userId: string,
): GithubMemoryUserConfig {
  return (
    parseRepoConfigs(repoConfigs).memory?.users?.[userId] ?? {
      repositories: [],
    }
  );
}

function githubMemoryContributorIsTrusted(args: {
  readonly repositoryConfig: GitHubMemoryRepositoryConfig;
  readonly githubUserId?: string | number | null;
  readonly login?: string | null;
  readonly email?: string | null;
}): boolean {
  const trusted = args.repositoryConfig.trustedContributors;
  if (trusted.length === 0) {
    return false;
  }

  const githubUserId =
    args.githubUserId === null || args.githubUserId === undefined
      ? null
      : String(args.githubUserId);
  const login = normalizeLogin(args.login ?? undefined);
  const email = normalizeEmail(args.email);

  return trusted.some((contributor) => {
    if (githubUserId && contributor.githubUserId === githubUserId) {
      return true;
    }
    if (login && normalizeLogin(contributor.login) === login) {
      return true;
    }
    return Boolean(email && normalizeEmail(contributor.email) === email);
  });
}

function issueSubjectKind(issue: GithubIssueDetail): GithubSubjectKind {
  return issue.pull_request === undefined ? "issue" : "pull_request";
}

function repositoryAllowsSubject(
  repository: GitHubMemoryRepositoryConfig,
  subjectKind: GithubSubjectKind,
): boolean {
  return subjectKind === "pull_request"
    ? repository.includePullRequests !== false
    : repository.includeIssues !== false;
}

function repositoryAllowsComments(
  repository: GitHubMemoryRepositoryConfig,
): boolean {
  return repository.includeComments !== false;
}

async function loadGithubMemoryInstallation(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<GithubMemoryInstallation | null> {
  const [row] = await db
    .select({
      id: githubInstallations.id,
      orgId: githubInstallations.orgId,
      remoteInstallationId: githubInstallations.installationId,
      targetName: githubInstallations.targetName,
      repoConfigs: githubInstallations.repoConfigs,
    })
    .from(githubInstallations)
    .innerJoin(
      githubUserLinks,
      eq(githubUserLinks.installationId, githubInstallations.id),
    )
    .where(
      and(
        eq(githubInstallations.orgId, scope.orgId),
        eq(githubInstallations.status, "active"),
        eq(githubUserLinks.vm0UserId, scope.userId),
      ),
    )
    .limit(1);

  if (!row?.remoteInstallationId) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.orgId,
    remoteInstallationId: row.remoteInstallationId,
    targetName: row.targetName,
    repoConfigs: row.repoConfigs,
  };
}

async function githubInstallationToken(args: {
  readonly installation: GithubMemoryInstallation;
  readonly signal: AbortSignal;
}): Promise<string> {
  const appId = optionalEnv("GITHUB_APP_ID");
  const privateKey = optionalEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    throw new Error("GitHub App is not configured");
  }

  const token = await getGithubInstallationAccessToken({
    appId,
    privateKey,
    installationId: args.installation.remoteInstallationId,
    signal: args.signal,
  });
  return token.token;
}

async function getGithubBackfillRow(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<{
  readonly status: GithubMemoryBackfillStatus;
  readonly estimatedTotal: number | null;
  readonly scannedCount: number;
  readonly recordedCount: number;
  readonly lastError: string | null;
  readonly updatedAt: Date | null;
  readonly completedAt: Date | null;
} | null> {
  const [backfill] = await db
    .select({
      status: relationshipBackfillJobs.status,
      estimatedTotal: relationshipBackfillJobs.estimatedTotal,
      scannedCount: relationshipBackfillJobs.scannedCount,
      recordedCount: relationshipBackfillJobs.enqueuedCount,
      lastError: relationshipBackfillJobs.lastError,
      updatedAt: relationshipBackfillJobs.updatedAt,
      completedAt: relationshipBackfillJobs.completedAt,
    })
    .from(relationshipBackfillJobs)
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "github"),
      ),
    )
    .limit(1);
  return backfill ?? null;
}

export async function getGithubMemoryStatus(
  db: ReadonlyDb,
  scope: MemoryScope,
): Promise<GithubMemoryStatusResponse> {
  const installation = await loadGithubMemoryInstallation(db, scope);
  const config = installation
    ? userMemoryConfig(installation.repoConfigs, scope.userId)
    : { repositories: [] };
  const repositories = selectedRepositories(config);
  const backfill = await getGithubBackfillRow(db, scope);

  return {
    provider: "github",
    connected: Boolean(installation),
    installationId: installation?.id ?? null,
    targetName: installation?.targetName ?? null,
    selectedRepositoryCount: repositories.length,
    trustedContributorCount: repositories.reduce((countValue, repository) => {
      return countValue + repository.trustedContributors.length;
    }, 0),
    backfill: {
      status: backfill?.status ?? "idle",
      estimatedTotal: backfill?.estimatedTotal ?? null,
      scannedCount: backfill?.scannedCount ?? 0,
      recordedCount: backfill?.recordedCount ?? 0,
      lastError: backfill?.lastError ?? null,
      updatedAt: serializeDate(backfill?.updatedAt ?? null),
      completedAt: serializeDate(backfill?.completedAt ?? null),
    },
  };
}

export async function listGithubMemoryRepositories(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly page: number;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<GithubMemoryRepositoriesResponse> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const installation = await loadGithubMemoryInstallation(args.db, scope);
  if (!installation) {
    return {
      provider: "github",
      connected: false,
      installationId: null,
      targetName: null,
      repositories: [],
      pagination: { page: args.page, pageSize: args.limit, hasMore: false },
    };
  }

  const token = await githubInstallationToken({
    installation,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  const listed = await fetchGithubInstallationRepositories({
    token,
    page: args.page,
    perPage: args.limit,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const config = userMemoryConfig(installation.repoConfigs, args.userId);
  return {
    provider: "github",
    connected: true,
    installationId: installation.id,
    targetName: installation.targetName,
    repositories: listed.repositories.map((repository) => {
      const configured = configuredRepository(config, repository.full_name);
      return {
        id: repository.id,
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        defaultBranch: repository.default_branch ?? null,
        selected: Boolean(configured),
        includeIssues: configured?.includeIssues ?? true,
        includePullRequests: configured?.includePullRequests ?? true,
        includeComments: configured?.includeComments ?? true,
        trustedContributors: configured
          ? [...configured.trustedContributors]
          : [],
      };
    }),
    pagination: {
      page: args.page,
      pageSize: args.limit,
      hasMore: listed.hasMore,
    },
  };
}

export async function listGithubMemoryContributors(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly repository: string;
  readonly page: number;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<GithubMemoryContributorsResponse> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const installation = await loadGithubMemoryInstallation(args.db, scope);
  if (!installation) {
    return {
      provider: "github",
      connected: false,
      repository: args.repository,
      contributors: [],
      pagination: { page: args.page, pageSize: args.limit, hasMore: false },
    };
  }

  const token = await githubInstallationToken({
    installation,
    signal: args.signal,
  });
  args.signal.throwIfAborted();
  const listed = await fetchGithubRepositoryContributors({
    token,
    repo: args.repository,
    page: args.page,
    perPage: args.limit,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const repositoryConfig = configuredRepository(
    userMemoryConfig(installation.repoConfigs, args.userId),
    args.repository,
  );
  return {
    provider: "github",
    connected: true,
    repository: args.repository,
    contributors: listed.contributors.flatMap((contributor) => {
      if (contributor.id === undefined) {
        return [];
      }
      return [
        {
          githubUserId: String(contributor.id),
          login: contributor.login,
          type: contributor.type ?? null,
          contributions: contributor.contributions ?? null,
          trusted: repositoryConfig
            ? githubMemoryContributorIsTrusted({
                repositoryConfig,
                githubUserId: contributor.id,
                login: contributor.login,
              })
            : false,
        },
      ];
    }),
    pagination: {
      page: args.page,
      pageSize: args.limit,
      hasMore: listed.hasMore,
    },
  };
}

export async function configureGithubMemory(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly options: GithubMemoryConfigureRequest;
  readonly signal: AbortSignal;
}): Promise<GithubMemoryMutationResult> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const installation = await loadGithubMemoryInstallation(args.db, scope);
  args.signal.throwIfAborted();
  if (!installation) {
    return {
      kind: "bad-request",
      message: "Connect GitHub before configuring memory sources.",
    };
  }

  const current = parseRepoConfigs(installation.repoConfigs);
  const users = current.memory?.users ?? {};
  const incomingRepositories = args.options.repositories
    .map(normalizeRepositoryConfig)
    .filter((repository) => {
      return repository.fullName.length > 0;
    });
  const existingRepositories =
    users[args.userId]?.repositories.map((repository) => {
      return [
        repository.fullName.toLowerCase(),
        {
          ...repository,
          trustedContributors: [...repository.trustedContributors],
        },
      ] as const;
    }) ?? [];
  const mergedRepositories = new Map<string, GitHubMemoryRepositoryConfig>(
    existingRepositories,
  );
  for (const repository of incomingRepositories) {
    mergedRepositories.set(repository.fullName.toLowerCase(), repository);
  }
  const nextConfig = {
    ...current,
    memory: {
      ...current.memory,
      users: {
        ...users,
        [args.userId]: {
          repositories: Array.from(mergedRepositories.values()),
          updatedAt: nowDate().toISOString(),
        },
      },
    },
  };

  await args.db
    .update(githubInstallations)
    .set({ repoConfigs: nextConfig, updatedAt: nowDate() })
    .where(eq(githubInstallations.id, installation.id));
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getGithubMemoryStatus(args.db, scope),
  };
}

async function upsertGithubBackfillJob(args: {
  readonly db: Db;
  readonly scope: MemoryScope;
  readonly installationId: string;
  readonly options: GithubMemoryBackfillRequest;
}): Promise<void> {
  const currentTime = nowDate();
  await args.db
    .insert(relationshipBackfillJobs)
    .values({
      orgId: args.scope.orgId,
      userId: args.scope.userId,
      provider: "github",
      connectorId: null,
      status: "pending",
      query: JSON.stringify(args.options),
      nextPageToken: serializeBackfillCursor({
        repositoryIndex: 0,
        issuePage: 1,
      }),
      createdAt: currentTime,
      updatedAt: currentTime,
    })
    .onConflictDoUpdate({
      target: [
        relationshipBackfillJobs.orgId,
        relationshipBackfillJobs.userId,
        relationshipBackfillJobs.provider,
      ],
      set: {
        connectorId: null,
        status: "pending",
        query: JSON.stringify(args.options),
        nextPageToken: serializeBackfillCursor({
          repositoryIndex: 0,
          issuePage: 1,
        }),
        estimatedTotal: null,
        scannedCount: 0,
        enqueuedCount: 0,
        lockedAt: null,
        lastRunAt: null,
        completedAt: null,
        attempts: 0,
        lastError: null,
        updatedAt: currentTime,
      },
    });
}

export async function restartGithubMemoryBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly options: GithubMemoryBackfillRequest;
  readonly signal: AbortSignal;
}): Promise<GithubMemoryMutationResult> {
  const scope = { orgId: args.orgId, userId: args.userId };
  const installation = await loadGithubMemoryInstallation(args.db, scope);
  args.signal.throwIfAborted();
  if (!installation) {
    return {
      kind: "bad-request",
      message: "Connect GitHub before backfilling memory sources.",
    };
  }

  const config = userMemoryConfig(installation.repoConfigs, args.userId);
  const repositories = selectedRepositories(config);
  if (repositories.length === 0) {
    return {
      kind: "bad-request",
      message: "Select at least one GitHub repository before backfilling.",
    };
  }
  if (
    repositories.every((repository) => {
      return repository.trustedContributors.length === 0;
    })
  ) {
    return {
      kind: "bad-request",
      message: "Select at least one trusted GitHub contributor.",
    };
  }

  await upsertGithubBackfillJob({
    db: args.db,
    scope,
    installationId: installation.id,
    options: args.options,
  });
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getGithubMemoryStatus(args.db, scope),
  };
}

export async function stopGithubMemoryBackfill(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
}): Promise<GithubMemoryMutationResult> {
  const scope = { orgId: args.orgId, userId: args.userId };
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: "stopped",
      lockedAt: null,
      lastError: null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(relationshipBackfillJobs.orgId, scope.orgId),
        eq(relationshipBackfillJobs.userId, scope.userId),
        eq(relationshipBackfillJobs.provider, "github"),
        inArray(relationshipBackfillJobs.status, ["pending", "running"]),
      ),
    );
  args.signal.throwIfAborted();

  return {
    kind: "ok",
    status: await getGithubMemoryStatus(args.db, scope),
  };
}

function issueAuthorTrusted(args: {
  readonly repository: GitHubMemoryRepositoryConfig;
  readonly issue: GithubIssueDetail;
}): boolean {
  return githubMemoryContributorIsTrusted({
    repositoryConfig: args.repository,
    githubUserId: args.issue.user.id,
    login: args.issue.user.login,
  });
}

function commentAuthorTrusted(args: {
  readonly repository: GitHubMemoryRepositoryConfig;
  readonly comment: GithubIssueComment;
}): boolean {
  return githubMemoryContributorIsTrusted({
    repositoryConfig: args.repository,
    githubUserId: args.comment.user.id,
    login: args.comment.user.login,
  });
}

function issueLikeForRecorder(issue: GithubIssueDetail) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    html_url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    labels: issue.labels ?? [],
    user: {
      id: issue.user.id,
      login: issue.user.login,
      type: issue.user.type,
    },
  };
}

function commentLikeForRecorder(comment: GithubIssueComment) {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.created_at,
    user: {
      id: comment.user.id,
      login: comment.user.login,
      type: comment.user.type,
    },
  };
}

async function recordBackfillIssue(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly installation: GithubMemoryInstallation;
  readonly repository: GitHubMemoryRepositoryConfig;
  readonly issue: GithubIssueDetail;
  readonly subjectKind: GithubSubjectKind;
}): Promise<boolean> {
  if (!issueAuthorTrusted({ repository: args.repository, issue: args.issue })) {
    return false;
  }

  return await recordGithubSubjectMemorySource({
    db: args.db,
    targetUserId: args.job.userId,
    installationRecord: {
      id: args.installation.id,
      orgId: args.installation.orgId,
      remoteInstallationId: args.installation.remoteInstallationId,
    },
    action: "backfill",
    issue: issueLikeForRecorder(args.issue),
    repository: { full_name: args.repository.fullName },
    installation: { id: Number(args.installation.remoteInstallationId) },
    sender: {
      id: args.issue.user.id,
      login: args.issue.user.login,
      type: args.issue.user.type,
    },
    subjectKind: args.subjectKind,
    reason: "github_backfill",
  });
}

async function recordBackfillComments(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly installation: GithubMemoryInstallation;
  readonly repository: GitHubMemoryRepositoryConfig;
  readonly token: string;
  readonly issue: GithubIssueDetail;
  readonly subjectKind: GithubSubjectKind;
  readonly since: Date;
  readonly signal: AbortSignal;
}): Promise<number> {
  if (!repositoryAllowsComments(args.repository)) {
    return 0;
  }

  const comments = await fetchGithubIssueComments({
    token: args.token,
    repo: args.repository.fullName,
    issueNumber: args.issue.number,
    since: args.since,
    paginate: true,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  let recorded = 0;
  for (const comment of comments) {
    args.signal.throwIfAborted();
    const occurredAt = new Date(comment.created_at);
    if (
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt.getTime() < args.since.getTime() ||
      !commentAuthorTrusted({ repository: args.repository, comment })
    ) {
      continue;
    }

    const didRecord = await recordGithubIssueCommentMemorySource({
      db: args.db,
      targetUserId: args.job.userId,
      installationRecord: {
        id: args.installation.id,
        orgId: args.installation.orgId,
        remoteInstallationId: args.installation.remoteInstallationId,
      },
      issue: issueLikeForRecorder(args.issue),
      comment: commentLikeForRecorder(comment),
      repository: { full_name: args.repository.fullName },
      installation: { id: Number(args.installation.remoteInstallationId) },
      sender: {
        id: comment.user.id,
        login: comment.user.login,
        type: comment.user.type,
      },
      subjectKind: args.subjectKind,
      reason: "github_backfill",
    });
    if (didRecord) {
      recorded += 1;
    }
  }
  return recorded;
}

async function processGithubBackfillJob(
  db: Db,
  job: typeof relationshipBackfillJobs.$inferSelect,
  signal: AbortSignal,
): Promise<{ readonly scanned: number; readonly recorded: number }> {
  const scope = { orgId: job.orgId, userId: job.userId };
  const installation = await loadGithubMemoryInstallation(db, scope);
  signal.throwIfAborted();
  if (!installation) {
    throw new Error("Connect GitHub before backfilling memory sources.");
  }

  const repositories = selectedRepositories(
    userMemoryConfig(installation.repoConfigs, job.userId),
  );
  const cursor = parseBackfillCursor(job.nextPageToken);
  const repository = repositories[cursor.repositoryIndex];
  if (!repository) {
    const currentTime = nowDate();
    await db
      .update(relationshipBackfillJobs)
      .set({
        status: "done",
        nextPageToken: null,
        lockedAt: null,
        lastRunAt: currentTime,
        completedAt: currentTime,
        lastError: null,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(relationshipBackfillJobs.id, job.id),
          eq(relationshipBackfillJobs.status, "running"),
        ),
      );
    return { scanned: 0, recorded: 0 };
  }

  const token = await githubInstallationToken({ installation, signal });
  signal.throwIfAborted();
  const options = parseBackfillOptions(job.query);
  const since = new Date(
    nowDate().getTime() - options.days * 24 * 60 * 60 * 1000,
  );
  const listed = await fetchGithubIssuesPage({
    token,
    repo: repository.fullName,
    page: cursor.issuePage,
    perPage: GITHUB_BACKFILL_PAGE_SIZE,
    since,
    signal,
  });
  signal.throwIfAborted();

  let recorded = 0;
  for (const issue of listed.items) {
    signal.throwIfAborted();
    const subjectKind = issueSubjectKind(issue);
    if (!repositoryAllowsSubject(repository, subjectKind)) {
      continue;
    }

    const didRecord = await recordBackfillIssue({
      db,
      job,
      installation,
      repository,
      issue,
      subjectKind,
    });
    if (didRecord) {
      recorded += 1;
    }

    recorded += await recordBackfillComments({
      db,
      job,
      installation,
      repository,
      token,
      issue,
      subjectKind,
      since,
      signal,
    });
  }

  const nextCursor = listed.hasMore
    ? { ...cursor, issuePage: cursor.issuePage + 1 }
    : { repositoryIndex: cursor.repositoryIndex + 1, issuePage: 1 };
  const completed = nextCursor.repositoryIndex >= repositories.length;
  const currentTime = nowDate();
  await db
    .update(relationshipBackfillJobs)
    .set({
      status: completed ? "done" : "pending",
      nextPageToken: completed ? null : serializeBackfillCursor(nextCursor),
      estimatedTotal: null,
      scannedCount: sql`${relationshipBackfillJobs.scannedCount} + ${listed.items.length}`,
      enqueuedCount: sql`${relationshipBackfillJobs.enqueuedCount} + ${recorded}`,
      lockedAt: null,
      lastRunAt: currentTime,
      completedAt: completed ? currentTime : null,
      lastError: null,
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );

  return { scanned: listed.items.length, recorded };
}

async function markGithubBackfillFailed(args: {
  readonly db: Db;
  readonly job: typeof relationshipBackfillJobs.$inferSelect;
  readonly error: unknown;
}) {
  const message =
    args.error instanceof Error ? args.error.message : String(args.error);
  const retry = args.job.attempts + 1 < 3;
  await args.db
    .update(relationshipBackfillJobs)
    .set({
      status: retry ? "pending" : "failed",
      lockedAt: null,
      attempts: sql`${relationshipBackfillJobs.attempts} + 1`,
      lastError: message,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(relationshipBackfillJobs.id, args.job.id),
        eq(relationshipBackfillJobs.status, "running"),
      ),
    );
}

export const advanceGithubMemorySourceBackfillJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const db = set(writeDb$);
    const currentTime = nowDate();
    const staleBefore = new Date(
      currentTime.getTime() - BACKFILL_LOCK_STALE_MS,
    );
    const jobs = await db
      .select()
      .from(relationshipBackfillJobs)
      .where(
        and(
          eq(relationshipBackfillJobs.provider, "github"),
          inArray(relationshipBackfillJobs.status, ["pending", "running"]),
          or(
            isNull(relationshipBackfillJobs.lockedAt),
            lt(relationshipBackfillJobs.lockedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(relationshipBackfillJobs.updatedAt))
      .limit(MAX_BACKFILL_JOBS_PER_DRAIN);
    signal.throwIfAborted();

    let processed = 0;
    let failed = 0;
    let scanned = 0;
    let enqueued = 0;

    for (const job of jobs) {
      const [lockedJob] = await db
        .update(relationshipBackfillJobs)
        .set({
          status: "running",
          lockedAt: nowDate(),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(relationshipBackfillJobs.id, job.id),
            inArray(relationshipBackfillJobs.status, ["pending", "running"]),
            or(
              isNull(relationshipBackfillJobs.lockedAt),
              lt(relationshipBackfillJobs.lockedAt, staleBefore),
            ),
          ),
        )
        .returning();
      signal.throwIfAborted();
      if (!lockedJob) {
        continue;
      }

      const result = await tapError(
        processGithubBackfillJob(db, lockedJob, signal),
        async (error) => {
          failed += 1;
          log.warn("GitHub memory source backfill failed", {
            jobId: lockedJob.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await markGithubBackfillFailed({
            db,
            job: lockedJob,
            error,
          });
        },
      );
      signal.throwIfAborted();
      if (!result) {
        continue;
      }

      processed += 1;
      scanned += result.scanned;
      enqueued += result.recorded;
    }

    return { processed, failed, scanned, enqueued };
  },
);
