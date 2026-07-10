import { logger } from "../../lib/log";
import { settle } from "../utils";

const GITHUB_API_BASE = "https://api.github.com";
const L = logger("GithubIssuesApi");

const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...GITHUB_HEADERS,
  };
}

export interface GithubIssueComment {
  readonly id: number;
  readonly user: {
    readonly login: string;
    readonly type: string;
    readonly id: number;
  };
  readonly body: string;
  readonly created_at: string;
}

export interface GithubIssueDetail {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly html_url?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly user: {
    readonly id: number;
    readonly login: string;
    readonly type: string;
  };
  readonly labels?: readonly {
    readonly name: string;
  }[];
  readonly pull_request?: unknown;
}

interface GithubRepositoryResource {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly default_branch?: string | null;
}

interface GithubContributor {
  readonly id?: number;
  readonly login: string;
  readonly type?: string;
  readonly contributions?: number;
}

interface GithubIssuePage {
  readonly items: readonly GithubIssueDetail[];
  readonly hasMore: boolean;
}

function hasNextPage(linkHeader: string | null): boolean {
  return linkHeader?.includes('rel="next"') ?? false;
}

export async function fetchGithubInstallationRepositories(args: {
  readonly token: string;
  readonly page: number;
  readonly perPage: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly repositories: readonly GithubRepositoryResource[];
  readonly hasMore: boolean;
}> {
  const url = new URL(`${GITHUB_API_BASE}/installation/repositories`);
  url.searchParams.set("page", String(args.page));
  url.searchParams.set("per_page", String(args.perPage));
  const response = await fetch(url, {
    headers: authHeaders(args.token),
    signal: args.signal,
  });

  if (!response.ok) {
    L.warn("Failed to fetch installation repositories", {
      status: response.status,
      page: args.page,
    });
    return { repositories: [], hasMore: false };
  }

  const data = (await response.json()) as {
    readonly repositories?: readonly GithubRepositoryResource[];
  };
  return {
    repositories: data.repositories ?? [],
    hasMore: hasNextPage(response.headers.get("link")),
  };
}

export async function fetchGithubRepositoryContributors(args: {
  readonly token: string;
  readonly repo: string;
  readonly page: number;
  readonly perPage: number;
  readonly signal: AbortSignal;
}): Promise<{
  readonly contributors: readonly GithubContributor[];
  readonly hasMore: boolean;
}> {
  const url = new URL(`${GITHUB_API_BASE}/repos/${args.repo}/contributors`);
  url.searchParams.set("page", String(args.page));
  url.searchParams.set("per_page", String(args.perPage));
  const response = await fetch(url, {
    headers: authHeaders(args.token),
    signal: args.signal,
  });

  if (!response.ok) {
    L.warn("Failed to fetch repository contributors", {
      status: response.status,
      repo: args.repo,
      page: args.page,
    });
    return { contributors: [], hasMore: false };
  }

  return {
    contributors: (await response.json()) as readonly GithubContributor[],
    hasMore: hasNextPage(response.headers.get("link")),
  };
}

export async function fetchGithubIssuesPage(args: {
  readonly token: string;
  readonly repo: string;
  readonly page: number;
  readonly perPage: number;
  readonly since: Date;
  readonly signal: AbortSignal;
}): Promise<GithubIssuePage> {
  const url = new URL(`${GITHUB_API_BASE}/repos/${args.repo}/issues`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("since", args.since.toISOString());
  url.searchParams.set("page", String(args.page));
  url.searchParams.set("per_page", String(args.perPage));
  const response = await fetch(url, {
    headers: authHeaders(args.token),
    signal: args.signal,
  });

  if (!response.ok) {
    L.warn("Failed to fetch issues page", {
      status: response.status,
      repo: args.repo,
      page: args.page,
    });
    return { items: [], hasMore: false };
  }

  return {
    items: (await response.json()) as readonly GithubIssueDetail[],
    hasMore: hasNextPage(response.headers.get("link")),
  };
}

export async function fetchGithubIssue(args: {
  readonly token: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly signal: AbortSignal;
}): Promise<GithubIssueDetail | null> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${args.repo}/issues/${args.issueNumber}`,
    {
      headers: authHeaders(args.token),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    L.warn("Failed to fetch issue", {
      status: response.status,
      repo: args.repo,
      issueNumber: args.issueNumber,
    });
    return null;
  }

  return (await response.json()) as GithubIssueDetail;
}

export async function fetchGithubIssueComments(args: {
  readonly token: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly since?: Date;
  readonly paginate?: boolean;
  readonly signal: AbortSignal;
}): Promise<readonly GithubIssueComment[]> {
  const comments: GithubIssueComment[] = [];
  let page = 1;

  while (true) {
    const url = new URL(
      `${GITHUB_API_BASE}/repos/${args.repo}/issues/${args.issueNumber}/comments`,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("direction", "asc");
    url.searchParams.set("page", String(page));
    if (args.since) {
      url.searchParams.set("since", args.since.toISOString());
    }

    const response = await fetch(url, {
      headers: authHeaders(args.token),
      signal: args.signal,
    });

    if (!response.ok) {
      L.warn("Failed to fetch issue comments", {
        status: response.status,
        repo: args.repo,
        issueNumber: args.issueNumber,
        page,
      });
      return comments;
    }

    comments.push(
      ...((await response.json()) as readonly GithubIssueComment[]),
    );

    if (args.paginate !== true || !hasNextPage(response.headers.get("link"))) {
      return comments;
    }
    page += 1;
  }
}

export async function fetchGithubIssueComment(args: {
  readonly token: string;
  readonly repo: string;
  readonly commentId: string;
  readonly signal: AbortSignal;
}): Promise<GithubIssueComment | null> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${args.repo}/issues/comments/${args.commentId}`,
    {
      headers: authHeaders(args.token),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    L.warn("Failed to fetch issue comment", {
      status: response.status,
      repo: args.repo,
      commentId: args.commentId,
    });
    return null;
  }

  return (await response.json()) as GithubIssueComment;
}

export async function postGithubIssueComment(args: {
  readonly token: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly body: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${args.repo}/issues/${args.issueNumber}/comments`,
    {
      method: "POST",
      headers: authHeaders(args.token),
      body: JSON.stringify({ body: args.body }),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to post GitHub comment: ${response.status} ${body}`,
    );
  }

  const data = (await response.json()) as { readonly id: number };
  return String(data.id);
}

export async function postGithubIssueCommentBestEffort(args: {
  readonly token: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly body: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const result = await settle(
    (async (): Promise<void> => {
      await postGithubIssueComment(args);
    })(),
  );

  if (!result.ok) {
    L.warn("Best-effort comment failed", {
      repo: args.repo,
      issueNumber: args.issueNumber,
      error: result.error,
    });
  }
}

export async function addGithubCommentReaction(args: {
  readonly token: string;
  readonly repo: string;
  readonly commentId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const result = await settle(
    (async (): Promise<string | undefined> => {
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${args.repo}/issues/comments/${args.commentId}/reactions`,
        {
          method: "POST",
          headers: authHeaders(args.token),
          body: JSON.stringify({ content: args.content }),
          signal: args.signal,
        },
      );

      if (!response.ok) {
        L.warn("Failed to add comment reaction", {
          commentId: args.commentId,
          content: args.content,
          status: response.status,
        });
        return undefined;
      }

      const data = (await response.json()) as { readonly id: number };
      return String(data.id);
    })(),
  );

  if (!result.ok) {
    L.warn("Failed to add comment reaction", {
      commentId: args.commentId,
      content: args.content,
      error: result.error,
    });
    return undefined;
  }

  return result.value;
}

export async function removeGithubCommentReaction(args: {
  readonly token: string;
  readonly repo: string;
  readonly commentId: string;
  readonly reactionId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const result = await settle(
    (async (): Promise<void> => {
      const response = await fetch(
        `${GITHUB_API_BASE}/repos/${args.repo}/issues/comments/${args.commentId}/reactions/${args.reactionId}`,
        {
          method: "DELETE",
          headers: authHeaders(args.token),
          signal: args.signal,
        },
      );

      if (!response.ok) {
        L.warn("Failed to remove comment reaction", {
          commentId: args.commentId,
          reactionId: args.reactionId,
          status: response.status,
        });
      }
    })(),
  );

  if (!result.ok) {
    L.warn("Failed to remove comment reaction", {
      commentId: args.commentId,
      reactionId: args.reactionId,
      error: result.error,
    });
  }
}
