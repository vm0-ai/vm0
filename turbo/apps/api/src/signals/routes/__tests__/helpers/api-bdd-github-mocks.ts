import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomInt } from "node:crypto";

import { HttpResponse, http } from "msw";
import { z } from "zod";

import { mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";

const GITHUB_APP_SLUG = "vm0-test";
const GITHUB_APP_CLIENT_ID = "github-app-client-id";
const GITHUB_APP_CLIENT_SECRET = "github-app-client-secret";

interface CapturedIssueComment {
  readonly repo: string;
  readonly issueNumber: string;
  readonly id: string;
  readonly body: string;
}

interface CapturedReactionDelete {
  readonly commentId: string;
  readonly reactionId: string;
}

interface GithubIssueApiCapture {
  readonly comments: CapturedIssueComment[];
  readonly reactionDeletes: CapturedReactionDelete[];
  lastCommentId(): string;
}

interface GithubIssueHistoryComment {
  readonly id: number;
  readonly login: string;
  readonly body: string;
}

const issueCommentRequestSchema = z.object({ body: z.string() });

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

export function mockGithubAppEnv(
  args: {
    readonly slug?: boolean;
    readonly credentials?: boolean;
    readonly oauthCredentials?: boolean;
  } = {},
): void {
  mockOptionalEnv(
    "GITHUB_APP_SLUG",
    args.slug === false ? undefined : GITHUB_APP_SLUG,
  );
  if (args.credentials === false) {
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
  } else {
    mockOptionalEnv("GITHUB_APP_ID", "123456");
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
  }
  if (args.oauthCredentials === false) {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", undefined);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", undefined);
  } else {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);
  }
}

/**
 * GitHub issue API surface used by webhook-created runs: installation access
 * tokens, comment history, posted comments (with incrementing ids), and
 * reaction add/remove. All issue comments observed by the test flow through
 * the returned capture arrays.
 */
export function captureGithubIssueApi(
  remoteInstallationId: string,
  options: {
    readonly commentHistory?: readonly GithubIssueHistoryComment[];
  } = {},
): GithubIssueApiCapture {
  const comments: CapturedIssueComment[] = [];
  const reactionDeletes: CapturedReactionDelete[] = [];
  let nextCommentId = randomInt(10_000, 99_999);
  let nextReactionId = randomInt(1000, 9999);

  server.use(
    http.post(
      `https://api.github.com/app/installations/${remoteInstallationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_bdd_issue_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
    http.get(
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      () => {
        return HttpResponse.json(
          (options.commentHistory ?? []).map((comment) => {
            return {
              id: comment.id,
              user: { login: comment.login, type: "User" },
              body: comment.body,
              created_at: "2026-05-20T00:00:00Z",
            };
          }),
        );
      },
    ),
    http.post(
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      async ({ params, request }) => {
        const payload = issueCommentRequestSchema.parse(await request.json());
        const id = nextCommentId;
        nextCommentId += 1;
        comments.push({
          repo: `${String(params.owner)}/${String(params.repo)}`,
          issueNumber: String(params.issueNumber),
          id: String(id),
          body: payload.body,
        });
        return HttpResponse.json({ id });
      },
    ),
    http.post(
      "https://api.github.com/repos/:owner/:repo/issues/comments/:commentId/reactions",
      () => {
        const id = nextReactionId;
        nextReactionId += 1;
        return HttpResponse.json({ id });
      },
    ),
    http.delete(
      "https://api.github.com/repos/:owner/:repo/issues/comments/:commentId/reactions/:reactionId",
      ({ params }) => {
        reactionDeletes.push({
          commentId: String(params.commentId),
          reactionId: String(params.reactionId),
        });
        return HttpResponse.json({});
      },
    ),
  );

  return {
    comments,
    reactionDeletes,
    lastCommentId(): string {
      const lastComment = comments[comments.length - 1];
      if (!lastComment) {
        throw new Error("No GitHub issue comment captured yet");
      }
      return lastComment.id;
    },
  };
}
