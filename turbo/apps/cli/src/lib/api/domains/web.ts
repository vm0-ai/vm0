import { createWriteStream, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";

/**
 * Minimal extension → MIME map covering the server allowlist for
 * `/api/zero/uploads`. Kept in this file rather than a shared module to
 * match the YAGNI pattern used elsewhere in the CLI.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
};

function inferContentType(localPath: string): string {
  const ext = extname(localPath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

interface DownloadWebFileResult {
  path: string;
  mimetype: string;
  size: number;
}

/**
 * Download a web-uploaded file to a local path, streaming the response body
 * to disk. Authenticates via ZERO_TOKEN. Response is binary, so this bypasses
 * the ts-rest contract system.
 */
export async function downloadWebFile(
  fileId: string,
  outPath: string,
): Promise<DownloadWebFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/zero/web/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    let message = `Failed to download web file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // ignore parse errors — keep generic message
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "Web download response has no body",
      "EMPTY_BODY",
      502,
    );
  }

  const mimetype =
    response.headers.get("x-file-mimetype") ??
    response.headers.get("content-type") ??
    "application/octet-stream";

  // Cast required: Web API ReadableStream and Node.js ReadableStream are
  // structurally compatible but have incompatible type declarations.
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );

  const contentLengthHeader = response.headers.get("content-length");
  const size = contentLengthHeader ? Number(contentLengthHeader) : 0;

  return { path: outPath, mimetype, size };
}

interface UploadWebFileResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

/**
 * Upload a local file to the zero uploads endpoint and receive back metadata
 * including a 7-day presigned GET URL. Authenticates via ZERO_TOKEN
 * (`file:write` capability) or a CLI PAT / Clerk session.
 */
export async function uploadWebFile(
  localPath: string,
  options?: { contentType?: string },
): Promise<UploadWebFileResult> {
  const stats = statSync(localPath);
  if (!stats.isFile()) {
    throw new ApiRequestError(
      `Not a regular file: ${localPath}`,
      "BAD_REQUEST",
      400,
    );
  }

  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const filename = basename(localPath);
  const contentType = options?.contentType ?? inferContentType(localPath);
  const bytes = readFileSync(localPath);
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });

  const formData = new FormData();
  formData.append("file", blob, filename);

  const url = new URL("/api/zero/uploads", baseUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: formData,
  });

  if (!response.ok) {
    let message = `Failed to upload file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // ignore parse errors — keep generic message
    }
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as UploadWebFileResult;
}
