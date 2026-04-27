import { NextResponse, type NextRequest } from "next/server";
import type { WebClient } from "@slack/web-api";
import { initServices } from "../../../../../../src/lib/init-services";
import { isSlackPlatformError } from "../../../../../../src/lib/zero/slack/client";
import {
  resolveSlackClient,
  isSlackClientError,
} from "../../../../../../src/lib/zero/slack/resolve-slack-client";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero:integrations:slack:download-file");

/**
 * Trusted Slack file download hostnames.
 * Explicit allowlist prevents SSRF via unintended subdomains.
 */
const ALLOWED_SLACK_DOWNLOAD_HOSTNAMES = new Set([
  "files.slack.com",
  "files-pri.slack.com",
  "cdn.slack.com",
]);

function isValidSlackDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_SLACK_DOWNLOAD_HOSTNAMES.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Maximum file size to proxy (100MB). */
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

function errorResponse(
  status: number,
  message: string,
  code: string,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

type SlackFileMetadata = {
  url: string;
  name: string;
  mimetype: string;
};

/**
 * Call Slack `files.info` and validate the returned metadata.
 * Returns either the validated fields or an error response the caller can
 * return directly.
 */
async function resolveSlackFileMetadata(
  client: WebClient,
  fileId: string,
): Promise<SlackFileMetadata | NextResponse> {
  const infoResult = await client.files.info({ file: fileId });
  if (!infoResult.ok || !infoResult.file) {
    return errorResponse(
      404,
      `Slack file not found: ${infoResult.error ?? "unknown"}`,
      "NOT_FOUND",
    );
  }

  const file = infoResult.file;
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    return errorResponse(
      404,
      "File does not have a downloadable URL",
      "NOT_FOUND",
    );
  }

  if (!isValidSlackDownloadUrl(url)) {
    log.warn("Rejected non-Slack download URL", { fileId, downloadUrl: url });
    return errorResponse(400, "Invalid Slack download URL", "BAD_REQUEST");
  }

  const size = file.size ?? 0;
  if (size > MAX_FILE_SIZE_BYTES) {
    return errorResponse(
      413,
      `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  return {
    url,
    name: file.name ?? fileId,
    mimetype: file.mimetype ?? "application/octet-stream",
  };
}

/**
 * GET /api/zero/integrations/slack/download-file?file_id=<id>
 *
 * Streams a Slack file to the caller using the org's bot token.
 * Requires `slack:write` capability.
 */
export async function GET(request: NextRequest): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization") ?? undefined;
  const slackCtx = await resolveSlackClient(authHeader, "slack:write");
  if (isSlackClientError(slackCtx)) {
    return NextResponse.json(slackCtx.body, { status: slackCtx.status });
  }

  const fileId = request.nextUrl.searchParams.get("file_id");
  if (!fileId) {
    return errorResponse(
      400,
      "file_id query parameter is required",
      "BAD_REQUEST",
    );
  }

  try {
    const meta = await resolveSlackFileMetadata(slackCtx.client, fileId);
    if (meta instanceof NextResponse) return meta;

    const downloadResponse = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${slackCtx.botToken}` },
      signal: request.signal,
    });

    if (!downloadResponse.ok) {
      log.warn("Slack download failed", {
        fileId,
        status: downloadResponse.status,
      });
      return errorResponse(
        502,
        `Failed to download file from Slack: ${downloadResponse.status}`,
        "BAD_GATEWAY",
      );
    }

    const responseContentType =
      downloadResponse.headers.get("content-type") ?? "";
    if (responseContentType.includes("text/html")) {
      log.warn("Slack returned HTML (likely expired token)", {
        fileId,
        contentType: responseContentType,
      });
      return errorResponse(
        502,
        "Slack returned an unexpected response (likely expired token)",
        "BAD_GATEWAY",
      );
    }

    const mimetype = meta.mimetype || responseContentType;
    const headers = new Headers();
    headers.set("Content-Type", mimetype);
    headers.set("X-File-Name", encodeURIComponent(meta.name));
    headers.set("X-File-Mimetype", mimetype);
    const contentLength = downloadResponse.headers.get("content-length");
    if (contentLength) {
      headers.set("Content-Length", contentLength);
    }

    return new Response(downloadResponse.body, { status: 200, headers });
  } catch (error) {
    if (isSlackPlatformError(error)) {
      return errorResponse(
        400,
        `Slack API error: ${error.data.error}`,
        "SLACK_ERROR",
      );
    }
    throw error;
  }
}
