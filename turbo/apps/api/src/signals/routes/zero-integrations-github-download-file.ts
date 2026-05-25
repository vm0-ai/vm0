import { command } from "ccstate";
import { initContract } from "@ts-rest/core";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { z } from "zod";

import { env } from "../../lib/env";
import {
  buildArtifactKey,
  buildArtifactPrefix,
  buildFileUrl,
} from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { listS3Objects } from "../external/s3";
import type { RouteEntry } from "../route";
import { settle } from "../utils";

const c = initContract();
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

const githubDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/github/download-file",
    headers: authHeadersSchema,
    query: z.object({
      file_id: z.string().uuid("file_id must be a GitHub file ID"),
      filename: z.string().min(1).max(255).optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a GitHub context file",
  },
});

function jsonResponse(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function filenameFromArtifactKey(key: string, fallback: string): string {
  const basename = key.split("/").filter(Boolean).pop();
  return basename ? decodeURIComponent(basename) : fallback;
}

const download$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(githubDownloadFileContract.download));
  const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
  const prefix = buildArtifactPrefix(auth.userId, query.file_id);
  const objects = await get(listS3Objects(bucket, prefix));
  signal.throwIfAborted();
  const expectedKey = query.filename
    ? buildArtifactKey(auth.userId, query.file_id, query.filename)
    : undefined;
  const object =
    expectedKey !== undefined
      ? objects.find((candidate) => {
          return candidate.key === expectedKey;
        })
      : objects[0];
  if (!object) {
    return jsonResponse(404, "GitHub file not found", "NOT_FOUND");
  }

  const filename = filenameFromArtifactKey(object.key, query.file_id);
  const url = buildFileUrl(auth.userId, query.file_id, filename);
  const headers = new Headers({ Accept: "application/octet-stream" });
  const downloadResult = await settle(
    fetch(url, {
      headers,
      signal,
    }),
  );
  signal.throwIfAborted();
  if (!downloadResult.ok) {
    return jsonResponse(
      502,
      "Failed to download GitHub file artifact",
      "BAD_GATEWAY",
    );
  }
  const downloadResponse = downloadResult.value;
  if (!downloadResponse.ok) {
    return jsonResponse(
      502,
      `Failed to download GitHub file artifact: ${downloadResponse.status}`,
      "BAD_GATEWAY",
    );
  }
  if (!downloadResponse.body) {
    return jsonResponse(
      502,
      "GitHub download response has no body",
      "EMPTY_BODY",
    );
  }

  const contentLength = downloadResponse.headers.get("content-length");
  const contentLengthBytes = parseContentLength(contentLength);
  if (
    contentLengthBytes !== undefined &&
    contentLengthBytes > MAX_FILE_SIZE_BYTES
  ) {
    return jsonResponse(
      413,
      `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const responseContentType = downloadResponse.headers.get("content-type");
  if (responseContentType?.includes("text/html")) {
    return jsonResponse(
      502,
      "GitHub file artifact returned an unexpected HTML response",
      "BAD_GATEWAY",
    );
  }
  const contentType = responseContentType ?? inferMimetype(filename);

  const responseHeaders = new Headers();
  responseHeaders.set("Content-Type", contentType);
  responseHeaders.set("X-File-Name", encodeURIComponent(filename));
  responseHeaders.set("X-File-Mimetype", contentType);
  if (contentLength) {
    responseHeaders.set("Content-Length", contentLength);
  }

  return new Response(downloadResponse.body, {
    status: 200,
    headers: responseHeaders,
  });
});

const githubReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "github:read",
} as const;

export const zeroIntegrationsGithubDownloadFileRoutes: readonly RouteEntry[] = [
  {
    route: githubDownloadFileContract.download,
    handler: authRoute(githubReadAuth, download$),
  },
];
