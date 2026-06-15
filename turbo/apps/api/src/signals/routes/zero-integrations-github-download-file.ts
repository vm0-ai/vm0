import { command } from "ccstate";
import { initContract } from "@ts-rest/core";
import { authHeadersSchema } from "@vm0/api-contracts/contracts/base";
import { apiErrorSchema } from "@vm0/api-contracts/contracts/errors";
import { z } from "zod";

import { inferMimetype } from "../../lib/mimetype";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
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
      url: z.string().url("url must be a GitHub file URL"),
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
    summary: "Download a GitHub context file URL",
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

const GITHUB_ASSET_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const GITHUB_CONTENT_HOSTS = [
  "objects.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
  "user-images.githubusercontent.com",
] as const;

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

function normalizeGithubDownloadUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/u, "");
}

function isAllowedGithubDownloadUrl(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "github.com") {
    return (
      parsed.pathname.startsWith("/user-attachments/assets/") ||
      parsed.pathname.startsWith("/user-attachments/files/")
    );
  }

  return GITHUB_CONTENT_HOSTS.some((host) => {
    return host === hostname;
  });
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

function filenameFromGithubDownloadUrl(url: string): string | null {
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  if (!segment || GITHUB_ASSET_ID_RE.test(segment)) {
    return null;
  }
  return segment;
}

function extensionFromContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  return normalized ? (EXTENSION_BY_CONTENT_TYPE[normalized] ?? null) : null;
}

function fallbackGithubFilename(contentType: string | null): string {
  const extension = extensionFromContentType(contentType);
  return extension ? `github-file.${extension}` : "github-file";
}

function sanitizeDownloadFilename(filename: string): string {
  return filename.trim().replace(/[/\\]/gu, "_").slice(0, 255) || "github-file";
}

const download$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(queryOf(githubDownloadFileContract.download));
  const fileUrl = normalizeGithubDownloadUrl(query.url);
  if (!isAllowedGithubDownloadUrl(fileUrl)) {
    return jsonResponse(
      400,
      "Only GitHub file attachment URLs can be downloaded",
      "BAD_REQUEST",
    );
  }

  const headers = new Headers({ Accept: "application/octet-stream" });
  const downloadResult = await settle(
    fetch(fileUrl, {
      headers,
      signal,
    }),
  );
  signal.throwIfAborted();
  if (!downloadResult.ok) {
    return jsonResponse(502, "Failed to download GitHub file", "BAD_GATEWAY");
  }
  const downloadResponse = downloadResult.value;
  if (!downloadResponse.ok) {
    const status = downloadResponse.status === 404 ? 404 : 502;
    return jsonResponse(
      status,
      `Failed to download GitHub file: ${downloadResponse.status}`,
      status === 404 ? "NOT_FOUND" : "BAD_GATEWAY",
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
      "GitHub returned an unexpected HTML file response",
      "BAD_GATEWAY",
    );
  }
  const filename = sanitizeDownloadFilename(
    query.filename ??
      filenameFromContentDisposition(
        downloadResponse.headers.get("content-disposition"),
      ) ??
      filenameFromGithubDownloadUrl(fileUrl) ??
      fallbackGithubFilename(responseContentType),
  );
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
