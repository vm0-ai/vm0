import { command } from "ccstate";
import { initContract } from "@ts-rest/core";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { z } from "zod";

import { inferMimetype } from "../../lib/mimetype";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$ } from "../external/db";
import {
  getGithubIntegrationAccessToken,
  loadActiveGithubInstallationForOrg,
} from "../services/github-integration-files.service";
import type { RouteEntry } from "../route";
import { settle } from "../utils";

const c = initContract();
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const ALLOWED_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
] as const;

const githubDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/zero/integrations/github/download-file",
    headers: authHeadersSchema,
    query: z.object({
      url: z.string().url(),
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
    summary: "Download a GitHub attachment or raw file",
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

function isAllowedGithubFileUrl(url: URL): boolean {
  const hostAllowed = ALLOWED_HOSTS.some((host) => {
    return host === url.hostname;
  });
  if (url.protocol !== "https:" || !hostAllowed) {
    return false;
  }

  if (url.hostname !== "github.com") {
    return true;
  }

  return url.pathname.startsWith("/user-attachments/assets/");
}

function filenameFromUrl(url: URL): string {
  const basename = url.pathname.split("/").filter(Boolean).pop();
  return basename ?? "github-file";
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    return utf8Match[1].trim();
  }

  const quotedMatch = value.match(/filename="([^"]+)"/iu);
  return quotedMatch?.[1] ?? null;
}

const download$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(githubDownloadFileContract.download));
  const url = new URL(query.url);
  if (!isAllowedGithubFileUrl(url)) {
    return jsonResponse(
      400,
      "Only GitHub attachment and raw file URLs are supported",
      "BAD_REQUEST",
    );
  }

  const db = get(db$);
  const installation = await loadActiveGithubInstallationForOrg({
    db,
    orgId: auth.orgId,
  });
  signal.throwIfAborted();
  if (!installation) {
    return jsonResponse(404, "No GitHub installation found", "NOT_FOUND");
  }

  const token = await getGithubIntegrationAccessToken({
    installation,
    signal,
  });
  signal.throwIfAborted();
  if (!token) {
    return jsonResponse(404, "No GitHub installation found", "NOT_FOUND");
  }

  const downloadResult = await settle(
    fetch(url, {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${token}`,
      },
      signal,
    }),
  );
  signal.throwIfAborted();
  if (!downloadResult.ok) {
    return jsonResponse(
      502,
      "Failed to download file from GitHub",
      "BAD_GATEWAY",
    );
  }
  const downloadResponse = downloadResult.value;
  if (!downloadResponse.ok) {
    return jsonResponse(
      502,
      `Failed to download file from GitHub: ${downloadResponse.status}`,
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

  const filename =
    query.filename ??
    filenameFromContentDisposition(
      downloadResponse.headers.get("content-disposition"),
    ) ??
    filenameFromUrl(url);
  const responseContentType = downloadResponse.headers.get("content-type");
  if (responseContentType?.includes("text/html")) {
    return jsonResponse(
      502,
      "GitHub returned an unexpected HTML response",
      "BAD_GATEWAY",
    );
  }
  const contentType = responseContentType ?? inferMimetype(filename);

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-File-Name", encodeURIComponent(filename));
  headers.set("X-File-Mimetype", contentType);
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(downloadResponse.body, { status: 200, headers });
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
