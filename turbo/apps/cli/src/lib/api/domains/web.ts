import { createWriteStream, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";

/**
 * Minimal extension → MIME map covering the server allowlist for
 * `/api/zero/uploads/prepare`. Kept in this file rather than a shared module
 * to match the YAGNI pattern used elsewhere in the CLI.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mpga": "audio/mpga",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".wave": "audio/wave",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odp": "application/vnd.oasis.opendocument.presentation",
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

interface GenerateWebVoiceOptions {
  text: string;
  voice?: string;
  instructions?: string;
}

interface GenerateWebVoiceResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  durationSeconds: number;
  creditsCharged: number;
  model: string;
  voice: string;
}

interface PrepareUploadResponse {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadUrl: string;
  url: string;
}

interface CompleteUploadResponse {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
}

async function parseErrorBody(
  response: Response,
  fallback: string,
): Promise<{ message: string; code: string }> {
  let message = `${fallback} (HTTP ${response.status})`;
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
  return { message, code };
}

/**
 * Upload a local file and receive back metadata including a 7-day presigned
 * GET URL. Authenticates via ZERO_TOKEN (`file:write` capability) or a CLI
 * PAT / Clerk session.
 *
 * Three-step flow:
 *   1. POST /api/zero/uploads/prepare — server signs a PUT URL for R2
 *   2. PUT the file bytes directly to R2
 *   3. POST /api/zero/uploads/complete — server verifies the object and
 *      records any run-scoped upload association
 *
 * Step 2 never touches the Next.js runtime, which lifts the cap from
 * Vercel's ~4.5 MB body limit up to R2's 5 GB single-PUT limit.
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

  const prepareHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    prepareHeaders["x-vercel-protection-bypass"] = bypassSecret;
  }

  const prepareUrl = new URL("/api/zero/uploads/prepare", baseUrl);
  const prepareRes = await fetch(prepareUrl, {
    method: "POST",
    headers: prepareHeaders,
    body: JSON.stringify({ filename, contentType, size: stats.size }),
  });

  if (!prepareRes.ok) {
    const { message, code } = await parseErrorBody(
      prepareRes,
      "Failed to prepare upload",
    );
    throw new ApiRequestError(message, code, prepareRes.status);
  }

  const prepared = (await prepareRes.json()) as PrepareUploadResponse;

  const bytes = readFileSync(localPath);
  const putRes = await fetch(prepared.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
  });

  if (!putRes.ok) {
    throw new ApiRequestError(
      `Failed to upload file to storage (HTTP ${putRes.status})`,
      "UPLOAD_FAILED",
      putRes.status,
    );
  }

  const completeUrl = new URL("/api/zero/uploads/complete", baseUrl);
  const completeRes = await fetch(completeUrl, {
    method: "POST",
    headers: prepareHeaders,
    body: JSON.stringify({
      id: prepared.id,
      contentType: prepared.contentType,
    }),
  });

  if (!completeRes.ok) {
    const { message, code } = await parseErrorBody(
      completeRes,
      "Failed to complete upload",
    );
    throw new ApiRequestError(message, code, completeRes.status);
  }

  const completed = (await completeRes.json()) as CompleteUploadResponse;

  return {
    id: completed.id,
    filename: completed.filename,
    contentType: completed.contentType,
    size: completed.size,
    url: completed.url,
  };
}

/**
 * Generate billed speech audio from text and receive the permanent /f URL.
 * Authenticates via ZERO_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebVoice(
  options: GenerateWebVoiceOptions,
): Promise<GenerateWebVoiceResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  const response = await fetch(new URL("/api/zero/voice-io/speech", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: options.text,
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.instructions ? { instructions: options.instructions } : {}),
    }),
  });

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate voice",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as GenerateWebVoiceResult;
}
