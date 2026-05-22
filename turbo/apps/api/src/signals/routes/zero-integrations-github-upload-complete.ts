import { command } from "ccstate";
import {
  integrationsGithubUploadCompleteContract,
  type GithubUploadCompleteBody,
} from "@vm0/api-contracts/contracts/integrations";

import { env } from "../../lib/env";
import { buildArtifactPrefix, buildFileUrl } from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import { listS3Objects } from "../external/s3";
import { postGithubIssueComment } from "../services/github-issues-api.service";
import {
  getGithubIntegrationAccessToken,
  loadActiveGithubInstallationForOrg,
} from "../services/github-integration-files.service";
import { recordGithubUploadedFile$ } from "../services/run-uploaded-files.service";
import type { RouteEntry } from "../route";
import { settle } from "../utils";

function routeError<Status extends 404 | 502 | 500>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

function markdownLinkText(text: string): string {
  return text.replace(/\\/gu, String.raw`\\`).replace(/\]/gu, String.raw`\]`);
}

function buildCommentBody(args: {
  readonly filename: string;
  readonly fileUrl: string;
  readonly caption: string | undefined;
}): string {
  const link = `[${markdownLinkText(args.filename)}](${args.fileUrl})`;
  const caption = args.caption?.trim();
  return caption ? `${caption}\n\n${link}` : link;
}

function buildMetadata(args: {
  readonly body: GithubUploadCompleteBody;
  readonly sourceUrl: string;
  readonly commentId: string;
}): Record<string, unknown> {
  return {
    repo: args.body.repo,
    issueNumber: args.body.issueNumber,
    uploadId: args.body.uploadId,
    sourceUrl: args.sourceUrl,
    ...(args.body.caption ? { caption: args.body.caption } : {}),
    githubComment: { id: args.commentId },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const runId =
    "runId" in auth && typeof auth.runId === "string" ? auth.runId : undefined;
  const bodyResult = await get(
    bodyResultOf(integrationsGithubUploadCompleteContract.complete),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const db = get(db$);
  const installation = await loadActiveGithubInstallationForOrg({
    db,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  if (!installation) {
    return routeError(404, "No GitHub installation found", "NOT_FOUND");
  }

  const token = await getGithubIntegrationAccessToken({
    installation,
    signal,
  });
  signal.throwIfAborted();
  if (!token) {
    return routeError(404, "No GitHub installation found", "NOT_FOUND");
  }

  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const prefix = buildArtifactPrefix(auth.userId, body.uploadId);
  const objects = await get(listS3Objects(bucket, prefix));
  signal.throwIfAborted();
  const object = objects[0];
  if (!object) {
    return routeError(404, "Uploaded file not found", "NOT_FOUND");
  }

  const filename = object.key.split("/").pop() ?? body.uploadId;
  const fileUrl = buildFileUrl(auth.userId, body.uploadId, filename);
  const mimetype = body.contentType ?? inferMimetype(filename);
  const commentBody = buildCommentBody({
    filename,
    fileUrl,
    caption: body.caption,
  });
  const commentResult = await settle(
    postGithubIssueComment({
      token,
      repo: body.repo,
      issueNumber: body.issueNumber,
      body: commentBody,
      signal,
    }),
  );
  signal.throwIfAborted();
  if (!commentResult.ok) {
    return routeError(
      502,
      `GitHub API error: ${errorMessage(commentResult.error)}`,
      "GITHUB_ERROR",
    );
  }
  const commentId = commentResult.value;

  await set(
    recordGithubUploadedFile$,
    {
      runId,
      externalId: commentId,
      userId: auth.userId,
      orgId: auth.orgId,
      filename,
      contentType: mimetype,
      sizeBytes: object.size,
      url: fileUrl,
      metadata: buildMetadata({ body, sourceUrl: fileUrl, commentId }),
    },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      commentId,
      repo: body.repo,
      issueNumber: body.issueNumber,
      filename,
      mimetype,
      size: object.size,
      url: fileUrl,
    },
  };
});

const githubWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:write",
} as const;

export const zeroIntegrationsGithubUploadCompleteRoutes: readonly RouteEntry[] =
  [
    {
      route: integrationsGithubUploadCompleteContract.complete,
      handler: authRoute(githubWriteAuth, complete$),
    },
  ];
