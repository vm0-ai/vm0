import { Buffer } from "node:buffer";

import { delay } from "signal-timers";

import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";

const L = logger("HeyGen");

const HEYGEN_API_BASE_URL = "https://api.heygen.com/v3";
const HEYGEN_VIDEOS_URL = `${HEYGEN_API_BASE_URL}/videos`;
const HEYGEN_RATE_LIMIT_RETRY_MAX_MS = 30_000;

type HeyGenErrorStatus = 400 | 502 | 503;

interface HeyGenErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface HeyGenErrorResponse {
  readonly status: HeyGenErrorStatus;
  readonly body: HeyGenErrorBody;
}

interface HeyGenAvatarVideoOptions {
  readonly avatarId: string;
  readonly audioUrl: string;
  readonly aspectRatio: "portrait" | "landscape" | "square";
  readonly videoName: string | undefined;
}

interface HeyGenAvatarVideoHandle {
  readonly videoId: string;
}

export type HeyGenAvatarVideoStatus =
  | { readonly kind: "pending" }
  | {
      readonly kind: "failed";
      readonly message: string;
    }
  | {
      readonly kind: "completed";
      readonly videoId: string;
      readonly sourceUrl: string;
      readonly durationSeconds: number;
    };

interface HeyGenDownloadedAvatarVideo {
  readonly videoBytes: Buffer;
  readonly contentType: "video/webm";
  readonly sourceUrl: string;
  readonly providerVideoId: string;
  readonly durationSeconds: number;
}

interface HeyGenRequestOptions {
  readonly method: "GET" | "POST";
  readonly url: URL | string;
  readonly body?: string;
  readonly idempotencyKey?: string;
  readonly retryRateLimit: boolean;
}

function errorBody(message: string, code: string): HeyGenErrorBody {
  return { error: { message, code } };
}

function badRequest(message: string): HeyGenErrorResponse {
  return { status: 400, body: errorBody(message, "BAD_REQUEST") };
}

function badGateway(message: string, code: string): HeyGenErrorResponse {
  return { status: 502, body: errorBody(message, code) };
}

function serviceUnavailable(
  message: string,
  code: string,
): HeyGenErrorResponse {
  return { status: 503, body: errorBody(message, code) };
}

export function isHeyGenErrorResponse(
  value: unknown,
): value is HeyGenErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "body" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function heyGenHeaders(
  apiKey: string,
  idempotencyKey: string | undefined,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  };
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) {
    return 1000;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 1000 : Math.max(0, timestamp - now());
}

async function requestHeyGen(
  options: HeyGenRequestOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<Response> {
  const request = () => {
    return fetch(options.url, {
      method: options.method,
      headers: heyGenHeaders(apiKey, options.idempotencyKey),
      ...(options.body ? { body: options.body } : {}),
      signal,
    });
  };
  const response = await request();
  if (response.status !== 429 || !options.retryRateLimit) {
    return response;
  }
  const retryAfterMs = retryAfterMilliseconds(
    response.headers.get("retry-after"),
  );
  if (retryAfterMs > HEYGEN_RATE_LIMIT_RETRY_MAX_MS) {
    return response;
  }
  await delay(retryAfterMs, { signal });
  return await request();
}

function providerErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return undefined;
  }
  return optionalString(value.error.message);
}

function heyGenProviderError(
  response: Response,
  value: unknown,
): HeyGenErrorResponse {
  const rawMessage = providerErrorMessage(value);
  const providerMessage = rawMessage
    ? redactPresignedUrls(rawMessage)
    : "Unknown provider error";
  L.warn("HeyGen API request failed", {
    status: response.status,
    providerMessage,
  });
  if (response.status === 400) {
    return badRequest(`HeyGen rejected the request: ${providerMessage}`);
  }
  if (response.status === 429) {
    return serviceUnavailable(
      "HeyGen is rate limited. Try again later.",
      "HEYGEN_RATE_LIMITED",
    );
  }
  if (response.status === 401 || response.status === 403) {
    return serviceUnavailable(
      "HeyGen avatar video generation is temporarily unavailable",
      "HEYGEN_UNAVAILABLE",
    );
  }
  return badGateway(
    `HeyGen avatar video generation failed: ${providerMessage}`,
    "HEYGEN_REQUEST_FAILED",
  );
}

async function readHeyGenResponse(
  response: Response,
): Promise<unknown | HeyGenErrorResponse> {
  const value = safeJsonParse(await response.text());
  return response.ok ? value : heyGenProviderError(response, value);
}

function heyGenAspectRatio(
  aspectRatio: HeyGenAvatarVideoOptions["aspectRatio"],
): "16:9" | "9:16" | "1:1" {
  switch (aspectRatio) {
    case "landscape": {
      return "16:9";
    }
    case "portrait": {
      return "9:16";
    }
    case "square": {
      return "1:1";
    }
  }
}

export async function submitHeyGenAvatarVideo(
  options: HeyGenAvatarVideoOptions,
  args: {
    readonly generationId: string;
    readonly callbackUrl: string;
  },
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenAvatarVideoHandle | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "POST",
      url: HEYGEN_VIDEOS_URL,
      body: JSON.stringify({
        type: "avatar",
        engine: { type: "avatar_iii" },
        avatar_id: options.avatarId,
        audio_url: options.audioUrl,
        aspect_ratio: heyGenAspectRatio(options.aspectRatio),
        resolution: "1080p",
        output_format: "webm",
        callback_url: args.callbackUrl,
        callback_id: args.generationId,
        ...(options.videoName ? { title: options.videoName } : {}),
      }),
      idempotencyKey: args.generationId,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response);
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const videoId = data ? optionalString(data.video_id) : undefined;
  if (!videoId) {
    return badGateway(
      "HeyGen returned no avatar video ID",
      "HEYGEN_NO_VIDEO_ID",
    );
  }
  return { videoId };
}

export async function getHeyGenAvatarVideoStatus(
  videoId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenAvatarVideoStatus | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "GET",
      url: `${HEYGEN_VIDEOS_URL}/${encodeURIComponent(videoId)}`,
      retryRateLimit: true,
    },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response);
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const status = data ? optionalString(data.status)?.toLowerCase() : undefined;
  if (
    status === "waiting" ||
    status === "pending" ||
    status === "processing" ||
    status === "rendering"
  ) {
    return { kind: "pending" };
  }
  if (status === "failed") {
    return {
      kind: "failed",
      message:
        (data && optionalString(data.failure_message)) ?? "Generation failed",
    };
  }
  if (status !== "completed" || !data) {
    return badGateway(
      "HeyGen returned an invalid video status",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const responseVideoId = optionalString(data.id);
  const sourceUrl = optionalString(data.video_url);
  const durationSeconds = optionalNumber(data.duration);
  if (
    responseVideoId !== videoId ||
    !sourceUrl ||
    !durationSeconds ||
    durationSeconds <= 0
  ) {
    return badGateway(
      "HeyGen returned an incomplete completed video",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return {
    kind: "completed",
    videoId,
    sourceUrl,
    durationSeconds,
  };
}

export async function downloadHeyGenAvatarVideo(
  status: Extract<HeyGenAvatarVideoStatus, { readonly kind: "completed" }>,
  signal: AbortSignal,
): Promise<HeyGenDownloadedAvatarVideo | HeyGenErrorResponse> {
  const response = await fetch(status.sourceUrl, { method: "GET", signal });
  if (!response.ok) {
    return badGateway(
      "Could not download the generated HeyGen avatar video",
      "VIDEO_DOWNLOAD_FAILED",
    );
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType && contentType !== "video/webm") {
    return badGateway(
      "HeyGen returned a non-WebM avatar video",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const videoBytes = Buffer.from(await response.arrayBuffer());
  if (videoBytes.byteLength === 0) {
    return badGateway("HeyGen returned an empty video", "NO_VIDEO_RETURNED");
  }
  return {
    videoBytes,
    contentType: "video/webm",
    sourceUrl: status.sourceUrl,
    providerVideoId: status.videoId,
    durationSeconds: status.durationSeconds,
  };
}
