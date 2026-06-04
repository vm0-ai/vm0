import { command } from "ccstate";
import type { ChatThreadGithubPr } from "@vm0/api-contracts/contracts/chat-threads";
import { connectors } from "@vm0/db/schema/connector";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { logger } from "../../lib/log";
import { db$, type ReadonlyDb } from "../external/db";
import { decryptStoredSecretValue } from "./crypto.utils";

const L = logger("ChatThreadGithubPrs");
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_CONNECTOR_TYPE = "github";
const GITHUB_TOKEN_SECRET_NAME = "GITHUB_ACCESS_TOKEN";
const MAX_TRACKED_GITHUB_PRS = 20;
const GITHUB_PR_URL_PATTERN =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/giu;

const githubPullSchema = z
  .object({
    title: z.string(),
    html_url: z.string(),
    state: z.enum(["open", "closed"]),
    merged_at: z.string().nullable().optional(),
    draft: z.boolean().optional(),
    mergeable: z.boolean().nullable().optional(),
    mergeable_state: z.string().nullable().optional(),
    head: z.object({ sha: z.string() }),
  })
  .passthrough();

const githubCheckRunSchema = z
  .object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable().optional(),
    html_url: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    completed_at: z.string().nullable().optional(),
  })
  .passthrough();

const githubCheckRunsSchema = z
  .object({
    check_runs: z.array(githubCheckRunSchema),
  })
  .passthrough();

const githubCommitStatusStateSchema = z.enum([
  "error",
  "failure",
  "pending",
  "success",
]);

const githubCommitStatusContextSchema = z
  .object({
    context: z.string(),
    state: githubCommitStatusStateSchema,
    target_url: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    updated_at: z.string().nullable().optional(),
  })
  .passthrough();

const githubCommitStatusSchema = z
  .object({
    state: githubCommitStatusStateSchema,
    statuses: z.array(githubCommitStatusContextSchema),
  })
  .passthrough();

type GithubPrRef = {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
};

type ChatThreadGithubPrsArgs = {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
};

type ThreadGithubContext = {
  readonly agentId: string;
};

type GithubConnectorAccess = {
  readonly authorized: boolean;
  readonly connected: boolean;
  readonly encryptedToken: string | null;
};

type ChatThreadGithubPrsResult =
  | {
      readonly status: "ok";
      readonly prs: readonly ChatThreadGithubPr[];
    }
  | {
      readonly status: "not_found";
    }
  | {
      readonly status: "forbidden";
      readonly message: string;
    }
  | {
      readonly status: "bad_gateway";
      readonly message: string;
    };

async function loadThreadGithubContext(
  db: ReadonlyDb,
  args: ChatThreadGithubPrsArgs,
): Promise<ThreadGithubContext | null> {
  const [thread] = await db
    .select({
      agentId: chatThreads.agentComposeId,
      orgId: zeroAgents.orgId,
    })
    .from(chatThreads)
    .leftJoin(zeroAgents, eq(zeroAgents.id, chatThreads.agentComposeId))
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);

  if (!thread || thread.orgId !== args.orgId) {
    return null;
  }

  return { agentId: thread.agentId };
}

async function loadGithubConnectorAccess(
  db: ReadonlyDb,
  args: ChatThreadGithubPrsArgs,
  agentId: string,
): Promise<GithubConnectorAccess> {
  const [authorization, connector, secret] = await Promise.all([
    db
      .select({ id: userConnectors.id })
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, args.orgId),
          eq(userConnectors.userId, args.userId),
          eq(userConnectors.agentId, agentId),
          eq(userConnectors.connectorType, GITHUB_CONNECTOR_TYPE),
        ),
      )
      .limit(1),
    db
      .select({
        id: connectors.id,
        needsReconnect: connectors.needsReconnect,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, GITHUB_CONNECTOR_TYPE),
        ),
      )
      .limit(1),
    db
      .select({ encryptedValue: secrets.encryptedValue })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, GITHUB_TOKEN_SECRET_NAME),
          eq(secrets.type, "connector"),
        ),
      )
      .limit(1),
  ]);

  return {
    authorized: Boolean(authorization[0]),
    connected: Boolean(connector[0] && !connector[0].needsReconnect),
    encryptedToken: secret[0]?.encryptedValue ?? null,
  };
}

async function loadThreadMessageContents(
  db: ReadonlyDb,
  threadId: string,
): Promise<readonly (string | null)[]> {
  const rows = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        isNotNull(chatMessages.content),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber))
    .limit(500);

  return rows.map((row) => {
    return row.content;
  });
}

function extractGithubPrRefs(
  contents: readonly (string | null)[],
): readonly GithubPrRef[] {
  const refs = new Map<string, GithubPrRef>();
  for (const content of contents) {
    if (!content) {
      continue;
    }

    for (const match of content.matchAll(GITHUB_PR_URL_PATTERN)) {
      const owner = match[1];
      const repo = match[2];
      const rawNumber = match[3];
      if (!owner || !repo || !rawNumber) {
        continue;
      }
      const number = Number.parseInt(rawNumber, 10);
      if (!Number.isSafeInteger(number) || number <= 0) {
        continue;
      }
      const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
      if (!refs.has(key)) {
        refs.set(key, { owner, repo, number });
      }
      if (refs.size >= MAX_TRACKED_GITHUB_PRS) {
        return [...refs.values()];
      }
    }
  }
  return [...refs.values()];
}

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "vm0",
  };
}

async function githubJson<T>(
  path: string,
  token: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    headers: githubHeaders(token),
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  return schema.parse(body);
}

function rollupCheckRuns(
  checks: readonly ChatThreadGithubPr["checks"][number][],
): ChatThreadGithubPr["rollup"] {
  if (checks.length === 0) {
    return "none";
  }

  if (
    checks.some((check) => {
      return check.status !== "completed";
    })
  ) {
    return "pending";
  }

  const failureConclusions = new Set([
    "failure",
    "timed_out",
    "action_required",
    "cancelled",
    "startup_failure",
    "stale",
  ]);
  if (
    checks.some((check) => {
      return (
        check.conclusion !== null && failureConclusions.has(check.conclusion)
      );
    })
  ) {
    return "failure";
  }

  return "success";
}

function githubPrMergeStatus(
  pull: z.infer<typeof githubPullSchema>,
  rollup: ChatThreadGithubPr["rollup"],
): ChatThreadGithubPr["mergeStatus"] {
  if (pull.state !== "open" || pull.merged_at) {
    return null;
  }

  if (pull.draft === true || pull.mergeable_state === "draft") {
    return "draft";
  }

  if (pull.mergeable === false || pull.mergeable_state === "dirty") {
    return "conflicts";
  }

  if (
    pull.mergeable_state === "clean" &&
    (rollup === "success" || rollup === "none")
  ) {
    return "ready";
  }

  if (pull.mergeable === true && (rollup === "success" || rollup === "none")) {
    return "ready";
  }

  if (
    pull.mergeable_state === "blocked" ||
    pull.mergeable_state === "behind" ||
    pull.mergeable_state === "has_hooks" ||
    pull.mergeable_state === "unstable"
  ) {
    return "blocked";
  }

  return null;
}

function githubStatusStateToCheckStatus(
  state: z.infer<typeof githubCommitStatusStateSchema>,
): string {
  return state === "pending" ? "in_progress" : "completed";
}

function githubStatusStateToConclusion(
  state: z.infer<typeof githubCommitStatusStateSchema>,
): string | null {
  if (state === "pending") {
    return null;
  }
  return state === "success" ? "success" : "failure";
}

function githubCommitStatusChecks(
  commitStatus: z.infer<typeof githubCommitStatusSchema>,
  fallbackUrl: string,
): ChatThreadGithubPr["checks"] {
  const checks = commitStatus.statuses.map((status) => {
    const checkStatus = githubStatusStateToCheckStatus(status.state);
    return {
      name: status.context || "GitHub status",
      status: checkStatus,
      conclusion: githubStatusStateToConclusion(status.state),
      url: status.target_url ?? null,
      startedAt: status.created_at ?? null,
      completedAt:
        checkStatus === "completed" ? (status.updated_at ?? null) : null,
    };
  });

  if (checks.length > 0 || commitStatus.state !== "pending") {
    return checks;
  }

  return [
    {
      name: "GitHub status",
      status: "in_progress",
      conclusion: null,
      url: fallbackUrl,
      startedAt: null,
      completedAt: null,
    },
  ];
}

async function fetchGithubPr(
  ref: GithubPrRef,
  token: string,
  signal: AbortSignal,
): Promise<ChatThreadGithubPr> {
  const repoPath = `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  const pull = await githubJson(
    `/repos/${repoPath}/pulls/${ref.number}`,
    token,
    githubPullSchema,
    signal,
  );
  const [checkRuns, commitStatus] = await Promise.all([
    githubJson(
      `/repos/${repoPath}/commits/${encodeURIComponent(pull.head.sha)}/check-runs?per_page=100`,
      token,
      githubCheckRunsSchema,
      signal,
    ),
    githubJson(
      `/repos/${repoPath}/commits/${encodeURIComponent(pull.head.sha)}/status`,
      token,
      githubCommitStatusSchema,
      signal,
    ),
  ]);

  const checks = [
    ...checkRuns.check_runs.map((check) => {
      return {
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? null,
        url: check.html_url ?? null,
        startedAt: check.started_at ?? null,
        completedAt: check.completed_at ?? null,
      };
    }),
    ...githubCommitStatusChecks(commitStatus, pull.html_url),
  ];
  const rollup = rollupCheckRuns(checks);

  return {
    repo: `${ref.owner}/${ref.repo}`,
    number: ref.number,
    title: pull.title,
    url: pull.html_url,
    state: pull.merged_at ? "merged" : pull.state,
    headSha: pull.head.sha,
    mergeStatus: githubPrMergeStatus(pull, rollup),
    rollup,
    checks,
  };
}

export const zeroChatThreadGithubPrs$ = command(
  async (
    { get },
    args: ChatThreadGithubPrsArgs,
    signal: AbortSignal,
  ): Promise<ChatThreadGithubPrsResult> => {
    const db = get(db$);
    const thread = await loadThreadGithubContext(db, args);
    signal.throwIfAborted();

    if (!thread) {
      return { status: "not_found" };
    }

    const access = await loadGithubConnectorAccess(db, args, thread.agentId);
    signal.throwIfAborted();

    if (!access.authorized) {
      return {
        status: "forbidden",
        message: "GitHub connector is not authorized for this agent",
      };
    }

    if (!access.connected) {
      return {
        status: "forbidden",
        message: "GitHub connector is not connected",
      };
    }

    if (!access.encryptedToken) {
      return {
        status: "forbidden",
        message: "GitHub connector token is missing",
      };
    }

    const contents = await loadThreadMessageContents(db, args.threadId);
    signal.throwIfAborted();

    const refs = extractGithubPrRefs(contents);
    if (refs.length === 0) {
      return { status: "ok", prs: [] };
    }

    const token = await decryptStoredSecretValue(access.encryptedToken, {
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    const results = await Promise.allSettled(
      refs.map((ref) => {
        return fetchGithubPr(ref, token, signal);
      }),
    );
    signal.throwIfAborted();

    const rejected = results.find((result) => {
      return result.status === "rejected";
    });
    if (rejected) {
      L.error("Failed to load GitHub PR status", { error: rejected.reason });
      return {
        status: "bad_gateway",
        message: "Failed to load GitHub PR status",
      };
    }

    const prs: ChatThreadGithubPr[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        prs.push(result.value);
      }
    }
    return { status: "ok", prs };
  },
);
