import { createWriteStream, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Realtime, type AuthOptions, type InboundMessage } from "ably";
import type {
  ZeroBuiltInGenerationAcceptedResponse,
  ZeroBuiltInGenerationResponse,
} from "@vm0/api-contracts/contracts/zero-built-in-generation";
import type { ZeroWebsiteIoGenerateResponse } from "@vm0/api-contracts/contracts/zero-website-io-generate";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";

const BUILT_IN_GENERATION_POLL_INTERVAL_MS = 2_000;
const BUILT_IN_GENERATION_WAIT_TIMEOUT_MS_BY_TYPE = {
  image: 15 * 60 * 1000,
  video: 30 * 60 * 1000,
  presentation: 60 * 60 * 1000,
} as const satisfies Record<
  ZeroBuiltInGenerationAcceptedResponse["type"],
  number
>;
const ABLY_CONNECT_TIMEOUT_MS = 10_000;

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
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".psd": "image/vnd.adobe.photoshop",
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
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".tsv": "text/tab-separated-values",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroenabled.12",
  ".dotm": "application/vnd.ms-word.template.macroenabled.12",
  ".dotx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".rtf": "application/rtf",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  ".xlsm": "application/vnd.ms-excel.sheet.macroenabled.12",
  ".xltm": "application/vnd.ms-excel.template.macroenabled.12",
  ".xltx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".potm": "application/vnd.ms-powerpoint.template.macroenabled.12",
  ".potx":
    "application/vnd.openxmlformats-officedocument.presentationml.template",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ppsx":
    "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
  ".ppsm": "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".key": "application/vnd.apple.keynote",
  ".parquet": "application/vnd.apache.parquet",
  ".sqlite": "application/vnd.sqlite3",
  ".sqlite3": "application/vnd.sqlite3",
  ".db": "application/vnd.sqlite3",
  ".epub": "application/epub+zip",
  ".ai": "application/postscript",
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

interface GenerateWebImageOptions {
  prompt: string;
  model?: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  outputCompression?: number;
  moderation?: string;
  seed?: number;
  safetyTolerance?: string;
  enhancePrompt?: boolean;
  imageUrls?: readonly string[];
  maskImageUrl?: string;
  inputFidelity?: string;
  imagePromptStrength?: number;
}

interface GenerateWebImageResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  creditsCharged: number;
  model: string;
  provider: string;
  imageSize: string;
  quality: string;
  background: string;
  outputFormat: string;
  outputCompression?: number;
  moderation?: string;
  safetyTolerance?: string;
  revisedPrompt?: string;
  usage?: {
    textInputTokens: number;
    imageInputTokens: number;
    imageOutputTokens: number;
    totalTokens: number;
  };
  billingCategory?: string;
  billingQuantity?: number;
  sourceUrl?: string;
  seed?: number;
  sourceImageUrls?: string[];
  maskImageUrl?: string;
  inputFidelity?: string;
  imagePromptStrength?: number;
}

interface GenerateWebVideoOptions {
  prompt: string;
  model?: string;
  aspectRatio?: string;
  duration?: string;
  resolution?: string;
  generateAudio?: boolean;
  negativePrompt?: string;
  seed?: number;
  autoFix?: boolean;
  safetyTolerance?: string;
}

interface GenerateWebVideoResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  durationSeconds: number;
  creditsCharged: number;
  model: string;
  aspectRatio: string;
  duration: string;
  resolution: string;
  generateAudio: boolean;
  sourceUrl: string;
  requestId?: string;
}

interface GenerateWebPresentationOptions {
  prompt: string;
  style?: string;
  slideCount?: number;
  imageCount?: number;
  imageModel?: string;
  theme?: string;
  audience?: string;
  title?: string;
}

interface GenerateWebPresentationResult {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  creditsCharged: number;
  model: string;
  style: string;
  theme: string;
  slideCount: number;
  imageCount: number;
  imageModel: string;
  imageUrls: string[];
  imageCreditsCharged: number;
  textCreditsCharged: number;
  title: string;
  responseId?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

interface GenerateWebWebsiteOptions {
  prompt: string;
  template?: string;
  title?: string;
  audience?: string;
}

type GenerateWebWebsiteResult = ZeroWebsiteIoGenerateResponse;

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

function authenticatedJsonHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuiltInGenerationAcceptedResponse(
  value: unknown,
): value is ZeroBuiltInGenerationAcceptedResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.generationId === "string" &&
    value.status === "queued" &&
    (value.type === "image" ||
      value.type === "video" ||
      value.type === "presentation") &&
    isRecord(value.realtime)
  );
}

interface BuiltInGenerationNotifier {
  wait(timeoutMs: number): Promise<void>;
  close(): void;
}

function createBuiltInGenerationRealtime(
  accepted: ZeroBuiltInGenerationAcceptedResponse,
): Realtime {
  let nextAuthRequest = accepted.realtime.tokenRequest;
  const authCallback: NonNullable<AuthOptions["authCallback"]> = (
    _params,
    callback,
  ) => {
    const current = nextAuthRequest;
    nextAuthRequest = accepted.realtime.tokenRequest;
    callback(null, current);
  };

  return new Realtime({
    authCallback,
    autoConnect: true,
    disconnectedRetryTimeout: 5000,
    suspendedRetryTimeout: 15_000,
  });
}

function waitForRealtimeConnected(
  ably: Realtime,
  timeoutMs = ABLY_CONNECT_TIMEOUT_MS,
): Promise<void> {
  if (ably.connection.state === "connected") {
    return Promise.resolve();
  }
  if (ably.connection.state === "failed") {
    return Promise.reject(new Error("Ably connection failed"));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out connecting to Ably"));
    }, timeoutMs);

    ably.connection.once("connected", () => {
      clearTimeout(timer);
      resolve();
    });
    ably.connection.once("failed", (stateChange) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Ably connection failed: ${stateChange?.reason?.message ?? "unknown"}`,
        ),
      );
    });
  });
}

async function createBuiltInGenerationNotifier(
  accepted: ZeroBuiltInGenerationAcceptedResponse,
): Promise<BuiltInGenerationNotifier | null> {
  const ably = createBuiltInGenerationRealtime(accepted);

  try {
    await waitForRealtimeConnected(ably);
    const channel = ably.channels.get(accepted.realtime.channelName);

    let pendingEvent = false;
    let closed = false;
    let wake: (() => void) | null = null;

    const wakeWaiter = () => {
      const current = wake;
      wake = null;
      current?.();
    };

    const onMessage = (_message: InboundMessage) => {
      if (wake) {
        wakeWaiter();
        return;
      }
      pendingEvent = true;
    };

    await channel.subscribe(accepted.realtime.eventName, onMessage);

    return {
      wait(timeoutMs: number): Promise<void> {
        if (pendingEvent || closed || timeoutMs <= 0) {
          pendingEvent = false;
          return Promise.resolve();
        }

        return new Promise((resolve) => {
          function done() {
            clearTimeout(timer);
            if (wake === done) {
              wake = null;
            }
            resolve();
          }
          const timer = setTimeout(done, timeoutMs);
          wake = done;
        });
      },
      close(): void {
        if (closed) {
          return;
        }
        closed = true;
        channel.unsubscribe(accepted.realtime.eventName, onMessage);
        wakeWaiter();
        ably.close();
      },
    };
  } catch {
    ably.close();
    return null;
  }
}

async function getBuiltInGenerationStatus(
  baseUrl: string,
  token: string,
  generationId: string,
): Promise<ZeroBuiltInGenerationResponse> {
  const response = await fetch(
    new URL(`/api/zero/built-in-generations/${generationId}`, baseUrl),
    { headers: authenticatedJsonHeaders(token) },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to get generation status",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as ZeroBuiltInGenerationResponse;
}

function readBuiltInGenerationResult<T>(
  status: ZeroBuiltInGenerationResponse,
  fallback: string,
): T | undefined {
  if (status.status === "completed") {
    if (!status.result) {
      throw new ApiRequestError(
        `${fallback} returned no result`,
        "EMPTY_RESULT",
        502,
      );
    }
    return status.result as T;
  }

  if (status.status === "failed") {
    const code = status.error?.code ?? "GENERATION_FAILED";
    throw new ApiRequestError(
      status.error?.message ?? `${fallback} failed`,
      code,
      statusForBuiltInGenerationError(code),
    );
  }

  return undefined;
}

function statusForBuiltInGenerationError(code: string): number {
  if (code === "BAD_REQUEST") {
    return 400;
  }
  if (code === "INSUFFICIENT_CREDITS") {
    return 402;
  }
  if (code === "NOT_CONFIGURED") {
    return 503;
  }
  if (code === "GENERATION_TIMEOUT") {
    return 504;
  }
  if (code.startsWith("NO_") || code.endsWith("_FAILED")) {
    return 502;
  }
  return 500;
}

async function waitForBuiltInGenerationResult<T>(args: {
  readonly accepted: ZeroBuiltInGenerationAcceptedResponse;
  readonly baseUrl: string;
  readonly token: string;
  readonly fallback: string;
}): Promise<T> {
  let notifier: BuiltInGenerationNotifier | null = null;
  let notifierCreated = false;
  const startedAt = Date.now();
  const timeoutMs =
    BUILT_IN_GENERATION_WAIT_TIMEOUT_MS_BY_TYPE[args.accepted.type];

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const status = await getBuiltInGenerationStatus(
        args.baseUrl,
        args.token,
        args.accepted.generationId,
      );
      const result = readBuiltInGenerationResult<T>(status, args.fallback);
      if (result) {
        return result;
      }

      const elapsed = Date.now() - startedAt;
      const remaining = timeoutMs - elapsed;
      const waitMs = Math.min(BUILT_IN_GENERATION_POLL_INTERVAL_MS, remaining);
      if (!notifierCreated) {
        notifier = await createBuiltInGenerationNotifier(args.accepted);
        notifierCreated = true;
      }
      if (notifier) {
        await notifier.wait(waitMs);
      } else {
        await delay(waitMs);
      }
    }
  } finally {
    notifier?.close();
  }

  throw new ApiRequestError(
    `${args.fallback} timed out (generationId: ${args.accepted.generationId})`,
    "GENERATION_TIMEOUT",
    504,
  );
}

async function readBuiltInGenerationResponse<T>(args: {
  readonly response: Response;
  readonly baseUrl: string;
  readonly token: string;
  readonly fallback: string;
}): Promise<T> {
  const body: unknown = await args.response.json();
  if (isBuiltInGenerationAcceptedResponse(body)) {
    return waitForBuiltInGenerationResult<T>({
      accepted: body,
      baseUrl: args.baseUrl,
      token: args.token,
      fallback: args.fallback,
    });
  }
  if (args.response.status === 202) {
    throw new ApiRequestError(
      `${args.fallback} returned an invalid generation response`,
      "INVALID_GENERATION_RESPONSE",
      502,
    );
  }
  return body as T;
}

/**
 * Upload a local file and receive back metadata including a public CDN URL.
 * Authenticates via ZERO_TOKEN (`file:write` capability) or a CLI
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
    headers: { "Content-Type": prepared.contentType },
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
 * Generate billed speech audio from text and receive the public CDN URL.
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

/**
 * Generate a billed image from a prompt and receive the public CDN URL.
 * Authenticates via ZERO_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebImage(
  options: GenerateWebImageOptions,
): Promise<GenerateWebImageResult> {
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

  const response = await fetch(
    new URL("/api/zero/image-io/generate", baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: options.prompt,
        ...(options.model ? { model: options.model } : {}),
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
        ...(options.background ? { background: options.background } : {}),
        ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
        ...(options.outputCompression !== undefined
          ? { outputCompression: options.outputCompression }
          : {}),
        ...(options.moderation ? { moderation: options.moderation } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.safetyTolerance
          ? { safetyTolerance: options.safetyTolerance }
          : {}),
        ...(options.enhancePrompt !== undefined
          ? { enhancePrompt: options.enhancePrompt }
          : {}),
        ...(options.imageUrls && options.imageUrls.length > 0
          ? { imageUrls: options.imageUrls }
          : {}),
        ...(options.maskImageUrl ? { maskImageUrl: options.maskImageUrl } : {}),
        ...(options.inputFidelity
          ? { inputFidelity: options.inputFidelity }
          : {}),
        ...(options.imagePromptStrength !== undefined
          ? { imagePromptStrength: options.imagePromptStrength }
          : {}),
      }),
    },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate image",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return readBuiltInGenerationResponse<GenerateWebImageResult>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate image",
  });
}

/**
 * Generate a billed video from a prompt and receive the public CDN URL.
 * Authenticates via ZERO_TOKEN (`file:write` capability) or a CLI PAT /
 * Clerk session.
 */
export async function generateWebVideo(
  options: GenerateWebVideoOptions,
): Promise<GenerateWebVideoResult> {
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

  const response = await fetch(
    new URL("/api/zero/video-io/generate", baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: options.prompt,
        ...(options.model ? { model: options.model } : {}),
        ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options.duration ? { duration: options.duration } : {}),
        ...(options.resolution ? { resolution: options.resolution } : {}),
        ...(options.generateAudio !== undefined
          ? { generateAudio: options.generateAudio }
          : {}),
        ...(options.negativePrompt
          ? { negativePrompt: options.negativePrompt }
          : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.autoFix !== undefined ? { autoFix: options.autoFix } : {}),
        ...(options.safetyTolerance
          ? { safetyTolerance: options.safetyTolerance }
          : {}),
      }),
    },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate video",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return readBuiltInGenerationResponse<GenerateWebVideoResult>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate video",
  });
}

/**
 * Generate a billed HTML presentation from a prompt and receive the permanent
 * /f URL. Authenticates via ZERO_TOKEN (`file:write` capability) or a CLI PAT
 * / Clerk session.
 */
export async function generateWebPresentation(
  options: GenerateWebPresentationOptions,
): Promise<GenerateWebPresentationResult> {
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

  const response = await fetch(
    new URL("/api/zero/presentation-io/generate", baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: options.prompt,
        ...(options.style ? { style: options.style } : {}),
        ...(options.slideCount !== undefined
          ? { slideCount: options.slideCount }
          : {}),
        ...(options.imageCount !== undefined
          ? { imageCount: options.imageCount }
          : {}),
        ...(options.imageModel ? { imageModel: options.imageModel } : {}),
        ...(options.theme ? { theme: options.theme } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
        ...(options.title ? { title: options.title } : {}),
      }),
    },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate presentation",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return readBuiltInGenerationResponse<GenerateWebPresentationResult>({
    response,
    baseUrl,
    token,
    fallback: "Failed to generate presentation",
  });
}

/**
 * Generate structured website template content from a prompt. The CLI builds
 * and publishes the generated content through zero host.
 */
export async function generateWebWebsite(
  options: GenerateWebWebsiteOptions,
): Promise<GenerateWebWebsiteResult> {
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

  const response = await fetch(
    new URL("/api/zero/website-io/generate", baseUrl),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: options.prompt,
        ...(options.template ? { template: options.template } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
      }),
    },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to generate website",
    );
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as GenerateWebWebsiteResult;
}
