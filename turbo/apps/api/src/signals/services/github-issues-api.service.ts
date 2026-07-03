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
  };
  readonly body: string;
  readonly created_at: string;
}

export async function fetchGithubIssueComments(args: {
  readonly token: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly signal: AbortSignal;
}): Promise<readonly GithubIssueComment[]> {
  const response = await fetch(
    `${GITHUB_API_BASE}/repos/${args.repo}/issues/${args.issueNumber}/comments?per_page=100&direction=asc`,
    {
      headers: authHeaders(args.token),
      signal: args.signal,
    },
  );

  if (!response.ok) {
    L.warn("Failed to fetch issue comments", {
      status: response.status,
      repo: args.repo,
      issueNumber: args.issueNumber,
    });
    return [];
  }

  return (await response.json()) as readonly GithubIssueComment[];
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
