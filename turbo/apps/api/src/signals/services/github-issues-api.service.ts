import { logger } from "../../lib/log";
import { tapError } from "../utils";

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

function hasNextPage(linkHeader: string | null): boolean {
  return linkHeader?.includes('rel="next"') ?? false;
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
  await tapError(
    (async (): Promise<void> => {
      await postGithubIssueComment(args);
    })(),
    (error) => {
      L.warn("Best-effort comment failed", {
        repo: args.repo,
        issueNumber: args.issueNumber,
        error,
      });
    },
  );
}

export async function addGithubCommentReaction(args: {
  readonly token: string;
  readonly repo: string;
  readonly commentId: string;
  readonly content: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  return await tapError(
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
    (error) => {
      L.warn("Failed to add comment reaction", {
        commentId: args.commentId,
        content: args.content,
        error,
      });
    },
  );
}

export async function removeGithubCommentReaction(args: {
  readonly token: string;
  readonly repo: string;
  readonly commentId: string;
  readonly reactionId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  await tapError(
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
    (error) => {
      L.warn("Failed to remove comment reaction", {
        commentId: args.commentId,
        reactionId: args.reactionId,
        error,
      });
    },
  );
}
