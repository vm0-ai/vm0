import { Buffer } from "node:buffer";

import { delay } from "signal-timers";
import {
  introVideoAvatarSchema,
  introVideoStyleSchema,
} from "@okouai/api-contracts/contracts/intro-video-presenter";

import { logger } from "../../lib/log";
import { redactPresignedUrls } from "../../lib/presigned-url-redaction";
import { now } from "../../lib/time";
import { safeJsonParse } from "../utils";

const L = logger("HeyGen");

const HEYGEN_API_BASE_URL = "https://api.heygen.com/v3";
const HEYGEN_AVATAR_LOOKS_URL = `${HEYGEN_API_BASE_URL}/avatars/looks`;
const HEYGEN_VIDEOS_URL = `${HEYGEN_API_BASE_URL}/videos`;
const HEYGEN_VIDEO_AGENT_STYLES_URL = `${HEYGEN_API_BASE_URL}/video-agents/styles`;
const HEYGEN_VOICES_URL = `${HEYGEN_API_BASE_URL}/voices`;
const HEYGEN_VOICE_SPEECH_URL = `${HEYGEN_VOICES_URL}/speech`;
const HEYGEN_AVATAR_PAGE_SIZE = 50;
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

interface HeyGenVoiceCatalogOptions {
  readonly token: string | undefined;
  readonly pageSize: number;
  readonly language: string | undefined;
  readonly gender: "female" | "male" | undefined;
}

interface HeyGenPublicVoice {
  readonly id: string;
  readonly name: string;
  readonly sampleUrl?: string;
  readonly language?: string;
  readonly gender?: "female" | "male";
}

interface HeyGenPublicVoicePage {
  readonly voices: readonly HeyGenPublicVoice[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

interface HeyGenAvatarCatalogOptions {
  readonly token: string | undefined;
  readonly pageSize: number;
  readonly groupId?: string;
}

interface HeyGenPublicAvatar {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly defaultVoiceId: string;
  readonly previewImageUrl?: string;
  readonly previewVideoUrl?: string;
  readonly gender?: "female" | "male";
  readonly imageWidth?: number;
  readonly imageHeight?: number;
  readonly preferredOrientation?: "landscape" | "portrait" | "square";
}

interface HeyGenPublicAvatarPage {
  readonly avatars: readonly HeyGenPublicAvatar[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

interface HeyGenStyleCatalogOptions {
  readonly token: string | undefined;
  readonly pageSize: number;
}

interface HeyGenPublicStyle {
  readonly id: string;
  readonly name: string;
  readonly thumbnailUrl?: string;
  readonly previewVideoUrl?: string;
  readonly tags: readonly string[];
  readonly aspectRatio?: "16:9" | "9:16" | "1:1";
}

interface HeyGenPublicStylePage {
  readonly styles: readonly HeyGenPublicStyle[];
  readonly hasMore: boolean;
  readonly nextToken: string | null;
}

interface HeyGenSpeechOptions {
  readonly voiceId: string;
  readonly text: string;
}

export interface HeyGenGeneratedSpeech {
  readonly audioBytes: Buffer;
  readonly contentType: "audio/mpeg" | "audio/wav";
  readonly sourceUrl: string;
  readonly providerRequestId: string | undefined;
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

function optionalUrl(value: unknown): string | undefined {
  const candidate = optionalString(value);
  if (!candidate || !URL.canParse(candidate)) {
    return undefined;
  }
  const url = new URL(candidate);
  return url.protocol === "https:" || url.protocol === "http:"
    ? candidate
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
      "HeyGen is temporarily unavailable",
      "HEYGEN_UNAVAILABLE",
    );
  }
  if (response.status >= 500) {
    return serviceUnavailable(
      "HeyGen is temporarily unavailable",
      "HEYGEN_UNAVAILABLE",
    );
  }
  return badGateway(
    `HeyGen request failed: ${providerMessage}`,
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

function parseHeyGenVoice(value: unknown): HeyGenPublicVoice | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.voice_id)?.trim();
  const name = optionalString(value.name)?.trim();
  if (!id || !name) {
    return null;
  }
  const sampleUrl = optionalUrl(value.preview_audio_url);
  const language = optionalString(value.language)?.trim();
  const normalizedGender = optionalString(value.gender)?.toLowerCase();
  const gender =
    normalizedGender === "female" || normalizedGender === "male"
      ? normalizedGender
      : undefined;
  return {
    id,
    name,
    ...(sampleUrl ? { sampleUrl } : {}),
    ...(language ? { language } : {}),
    ...(gender ? { gender } : {}),
  };
}

function parseHeyGenGender(value: unknown): "female" | "male" | undefined {
  const normalized = optionalString(value)?.toLowerCase();
  return normalized === "female" || normalized === "male"
    ? normalized
    : undefined;
}

function parseHeyGenOrientation(
  value: unknown,
): "landscape" | "portrait" | "square" | undefined {
  const normalized = optionalString(value);
  return normalized === "landscape" ||
    normalized === "portrait" ||
    normalized === "square"
    ? normalized
    : undefined;
}

function parsePositiveInteger(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseHeyGenAvatar(value: unknown): HeyGenPublicAvatar | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.id)?.trim();
  const groupId = optionalString(value.group_id)?.trim();
  const name = optionalString(value.name)?.trim();
  const defaultVoiceId = optionalString(value.default_voice_id)?.trim();
  const engines = Array.isArray(value.supported_api_engines)
    ? value.supported_api_engines
    : [];
  if (
    !id ||
    !groupId ||
    !name ||
    !defaultVoiceId ||
    value.status !== "completed" ||
    !engines.includes("avatar_iii")
  ) {
    return null;
  }
  const previewImageUrl = optionalUrl(value.preview_image_url);
  const previewVideoUrl = optionalUrl(value.preview_video_url);
  const gender = parseHeyGenGender(value.gender);
  const imageWidth = parsePositiveInteger(value.image_width);
  const imageHeight = parsePositiveInteger(value.image_height);
  const preferredOrientation = parseHeyGenOrientation(
    value.preferred_orientation,
  );
  const parsed = introVideoAvatarSchema.safeParse({
    id,
    groupId,
    name,
    defaultVoiceId,
    ...(previewImageUrl ? { previewImageUrl } : {}),
    ...(previewVideoUrl ? { previewVideoUrl } : {}),
    ...(gender ? { gender } : {}),
    ...(imageWidth ? { imageWidth } : {}),
    ...(imageHeight ? { imageHeight } : {}),
    ...(preferredOrientation ? { preferredOrientation } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function parseHeyGenStyle(value: unknown): HeyGenPublicStyle | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.style_id)?.trim();
  const name = optionalString(value.name)?.trim();
  if (!id || !name) {
    return null;
  }
  const thumbnailUrl = optionalUrl(value.thumbnail_url);
  const previewVideoUrl = optionalUrl(value.preview_video_url);
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => {
        const parsed = optionalString(tag)?.trim();
        return parsed ? [parsed] : [];
      })
    : [];
  const rawAspectRatio = optionalString(value.aspect_ratio);
  const aspectRatio =
    rawAspectRatio === "16:9" ||
    rawAspectRatio === "9:16" ||
    rawAspectRatio === "1:1"
      ? rawAspectRatio
      : undefined;
  const parsed = introVideoStyleSchema.safeParse({
    id,
    name,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(previewVideoUrl ? { previewVideoUrl } : {}),
    tags,
    ...(aspectRatio ? { aspectRatio } : {}),
  });
  return parsed.success ? parsed.data : null;
}

function parseHeyGenPage(value: unknown):
  | {
      readonly data: readonly unknown[];
      readonly hasMore: boolean;
      readonly nextToken: string | null;
    }
  | HeyGenErrorResponse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    typeof value.has_more !== "boolean"
  ) {
    return badGateway(
      "HeyGen returned an invalid catalog page",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const nextToken = optionalString(value.next_token) ?? null;
  if (value.has_more && !nextToken) {
    return badGateway(
      "HeyGen returned an incomplete catalog page",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return { data: value.data, hasMore: value.has_more, nextToken };
}

export async function listHeyGenPublicAvatars(
  options: HeyGenAvatarCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicAvatarPage | HeyGenErrorResponse> {
  const url = new URL(HEYGEN_AVATAR_LOOKS_URL);
  url.searchParams.set("ownership", "public");
  url.searchParams.set("avatar_type", "studio_avatar");
  url.searchParams.set(
    "limit",
    String(Math.min(options.pageSize, HEYGEN_AVATAR_PAGE_SIZE)),
  );
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  if (options.groupId) {
    url.searchParams.set("group_id", options.groupId);
  }
  const response = await requestHeyGen(
    { method: "GET", url, retryRateLimit: true },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response);
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const page = parseHeyGenPage(body);
  if (isHeyGenErrorResponse(page)) {
    return page;
  }
  return {
    avatars: page.data.flatMap((value) => {
      const avatar = parseHeyGenAvatar(value);
      return avatar ? [avatar] : [];
    }),
    hasMore: page.hasMore,
    nextToken: page.nextToken,
  };
}

export async function listHeyGenPublicStyles(
  options: HeyGenStyleCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicStylePage | HeyGenErrorResponse> {
  const url = new URL(HEYGEN_VIDEO_AGENT_STYLES_URL);
  url.searchParams.set("limit", String(options.pageSize));
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  const response = await requestHeyGen(
    { method: "GET", url, retryRateLimit: true },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response);
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  const page = parseHeyGenPage(body);
  if (isHeyGenErrorResponse(page)) {
    return page;
  }
  return {
    styles: page.data.flatMap((value) => {
      const style = parseHeyGenStyle(value);
      return style ? [style] : [];
    }),
    hasMore: page.hasMore,
    nextToken: page.nextToken,
  };
}

export async function verifyHeyGenPublicAvatar(
  avatarId: string,
  groupId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<boolean | HeyGenErrorResponse> {
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await listHeyGenPublicAvatars(
      { groupId, token, pageSize: HEYGEN_AVATAR_PAGE_SIZE },
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    if (
      page.avatars.some((avatar) => {
        return avatar.id === avatarId && avatar.groupId === groupId;
      })
    ) {
      return true;
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated avatar catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return false;
}

export async function verifyHeyGenPublicVoice(
  voiceId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<boolean | HeyGenErrorResponse> {
  let token: string | undefined;
  const seenTokens = new Set<string>();
  do {
    const page = await listHeyGenPublicVoices(
      { token, pageSize: 100, language: undefined, gender: undefined },
      apiKey,
      signal,
    );
    if (isHeyGenErrorResponse(page)) {
      return page;
    }
    if (
      page.voices.some((voice) => {
        return voice.id === voiceId;
      })
    ) {
      return true;
    }
    const nextToken = page.hasMore ? (page.nextToken ?? undefined) : undefined;
    if (nextToken && seenTokens.has(nextToken)) {
      return badGateway(
        "HeyGen returned a repeated voice catalog token",
        "HEYGEN_BAD_RESPONSE",
      );
    }
    if (nextToken) {
      seenTokens.add(nextToken);
    }
    token = nextToken;
  } while (token);
  return false;
}

export async function listHeyGenPublicVoices(
  options: HeyGenVoiceCatalogOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenPublicVoicePage | HeyGenErrorResponse> {
  const url = new URL(HEYGEN_VOICES_URL);
  url.searchParams.set("type", "public");
  url.searchParams.set("engine", "starfish");
  url.searchParams.set("limit", String(options.pageSize));
  if (options.token) {
    url.searchParams.set("token", options.token);
  }
  if (options.language) {
    url.searchParams.set("language", options.language);
  }
  if (options.gender) {
    url.searchParams.set("gender", options.gender);
  }
  const response = await requestHeyGen(
    { method: "GET", url, retryRateLimit: true },
    apiKey,
    signal,
  );
  const body = await readHeyGenResponse(response);
  if (isHeyGenErrorResponse(body)) {
    return body;
  }
  if (
    !isRecord(body) ||
    !Array.isArray(body.data) ||
    typeof body.has_more !== "boolean"
  ) {
    return badGateway(
      "HeyGen returned an invalid voice list",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const nextToken = optionalString(body.next_token) ?? null;
  if (body.has_more && !nextToken) {
    return badGateway(
      "HeyGen returned an incomplete voice page",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  return {
    voices: body.data.flatMap((value) => {
      const voice = parseHeyGenVoice(value);
      return voice ? [voice] : [];
    }),
    hasMore: body.has_more,
    nextToken,
  };
}

function heyGenSpeechContentType(
  response: Response,
  sourceUrl: string,
): "audio/mpeg" | "audio/wav" | null {
  const header = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (
    header === "audio/wav" ||
    header === "audio/wave" ||
    header === "audio/x-wav"
  ) {
    return "audio/wav";
  }
  if (header === "audio/mpeg" || header === "audio/mp3") {
    return "audio/mpeg";
  }
  if (!header || header === "application/octet-stream") {
    return new URL(sourceUrl).pathname.toLowerCase().endsWith(".wav")
      ? "audio/wav"
      : "audio/mpeg";
  }
  return null;
}

export async function generateHeyGenSpeech(
  options: HeyGenSpeechOptions,
  apiKey: string,
  signal: AbortSignal,
): Promise<HeyGenGeneratedSpeech | HeyGenErrorResponse> {
  const response = await requestHeyGen(
    {
      method: "POST",
      url: HEYGEN_VOICE_SPEECH_URL,
      body: JSON.stringify({
        text: options.text,
        voice_id: options.voiceId,
        input_type: "text",
        speed: 1,
      }),
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
  const sourceUrl = data ? optionalUrl(data.audio_url) : undefined;
  const durationSeconds = data ? optionalNumber(data.duration) : undefined;
  if (!sourceUrl || !durationSeconds || durationSeconds <= 0) {
    return badGateway(
      "HeyGen returned incomplete narration audio",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const audioResponse = await fetch(sourceUrl, { method: "GET", signal });
  if (!audioResponse.ok) {
    return badGateway(
      "Could not download the generated HeyGen narration",
      "AUDIO_DOWNLOAD_FAILED",
    );
  }
  const contentType = heyGenSpeechContentType(audioResponse, sourceUrl);
  if (!contentType) {
    return badGateway(
      "HeyGen returned an unsupported narration format",
      "HEYGEN_BAD_RESPONSE",
    );
  }
  const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
  if (audioBytes.byteLength === 0) {
    return badGateway("HeyGen returned empty narration", "NO_AUDIO_RETURNED");
  }
  return {
    audioBytes,
    contentType,
    sourceUrl,
    providerRequestId: data ? optionalString(data.request_id) : undefined,
    durationSeconds,
  };
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
