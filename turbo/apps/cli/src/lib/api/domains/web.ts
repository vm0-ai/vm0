import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";

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
