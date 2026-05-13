import { logger } from "../../lib/log";
import { safeAsync } from "../utils";

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

export async function removeGithubCommentReaction(args: {
  readonly token: string;
  readonly repo: string;
  readonly commentId: string;
  readonly reactionId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const result = await safeAsync(async (): Promise<void> => {
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
  });

  if ("error" in result) {
    L.warn("Failed to remove comment reaction", {
      commentId: args.commentId,
      reactionId: args.reactionId,
      error: result.error,
    });
  }
}
