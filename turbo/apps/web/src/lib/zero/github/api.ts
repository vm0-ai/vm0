import { logger } from "../../shared/logger";

const log = logger("github:api");

const GITHUB_API_BASE = "https://api.github.com";

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

// ─── Issue Comments ──────────────────────────────────────────────────

export interface IssueComment {
  id: number;
  user: { login: string; type: string };
  body: string;
  created_at: string;
}

/**
 * Fetch issue comments from GitHub API.
 * Returns up to 100 most recent comments.
 * Returns empty array on failure (with warning logged).
 */
export async function fetchIssueComments(
  token: string,
  repo: string,
  issueNumber: number,
): Promise<IssueComment[]> {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${repo}/issues/${issueNumber}/comments?per_page=100&direction=asc`,
    { headers: authHeaders(token) },
  );

  if (!res.ok) {
    log.warn("Failed to fetch issue comments", {
      status: res.status,
      repo,
      issueNumber,
    });
    return [];
  }

  return (await res.json()) as IssueComment[];
}

/**
 * Post a comment to a GitHub issue.
 * Returns the comment ID on success, throws on failure.
 */
async function postIssueComment(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<string> {
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ body }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to post GitHub comment: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { id: number };
  return String(data.id);
}

/**
 * Post a comment to a GitHub issue, swallowing errors.
 * Use for best-effort feedback (e.g. error comments) where failure to post
 * should not disrupt the calling flow.
 */
export async function postIssueCommentBestEffort(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  try {
    await postIssueComment(token, repo, issueNumber, body);
  } catch (error) {
    log.warn("Best-effort comment failed", {
      repo,
      issueNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Reactions ───────────────────────────────────────────────────────

/**
 * Add a reaction to a GitHub issue comment.
 * Best-effort: returns undefined on failure (network or API error).
 */
export async function addCommentReaction(
  token: string,
  repo: string,
  commentId: string,
  content: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${GITHUB_API_BASE}/repos/${repo}/issues/comments/${commentId}/reactions`,
      {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ content }),
      },
    );

    if (!res.ok) {
      log.warn("Failed to add comment reaction", {
        commentId,
        content,
        status: res.status,
      });
      return undefined;
    }

    const data = (await res.json()) as { id: number };
    return String(data.id);
  } catch (error) {
    log.warn("Failed to add comment reaction", {
      commentId,
      content,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Remove a reaction from a GitHub issue comment.
 * Best-effort: logs warning on failure (network or API error).
 */
export async function removeCommentReaction(
  token: string,
  repo: string,
  commentId: string,
  reactionId: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${GITHUB_API_BASE}/repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`,
      {
        method: "DELETE",
        headers: authHeaders(token),
      },
    );

    if (!res.ok) {
      log.warn("Failed to remove comment reaction", {
        commentId,
        reactionId,
        status: res.status,
      });
    }
  } catch (error) {
    log.warn("Failed to remove comment reaction", {
      commentId,
      reactionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
