import { NextResponse } from "next/server";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { getOrgTierSafe } from "../../../../../src/lib/zero/org/org-metadata-service";
import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import { recordBehavior } from "../../../../../src/lib/zero/behavior/user-behavior-count-service";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  checkAudioInputQuota,
  MAX_REQUEST_DURATION_SECONDS,
  DAILY_RATE_LIMITS,
  DAILY_DURATION_LIMITS,
  dailyRateKey,
  dailyDurationKey,
  getDailyCounts,
} from "../../../../../src/lib/zero/voice-io/audio-input-policy";
import { getAudioDuration } from "../../../../../src/lib/zero/voice-io/audio-duration";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:zero:voice-io:stt");

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB (OpenAI limit)

const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpga",
]);

async function checkDailyLimits(
  orgId: string,
  userId: string,
  orgTier: OrgTier,
  durationSeconds: number | null,
): Promise<NextResponse | null> {
  const { rateCount, durationSeconds: dailyDurationSeconds } =
    await getDailyCounts(orgId, userId);

  const rateLimit = DAILY_RATE_LIMITS[orgTier];
  if (rateLimit !== null && rateLimit !== undefined && rateCount >= rateLimit) {
    return NextResponse.json(
      {
        error: {
          message: "Daily request rate limit exceeded",
          code: "DAILY_RATE_LIMIT_EXCEEDED",
        },
        quota: { count: rateCount, limit: rateLimit },
      },
      { status: 429 },
    );
  }

  const durationLimit = DAILY_DURATION_LIMITS[orgTier];
  const safeDuration = durationSeconds ?? 0;
  if (
    durationLimit !== null &&
    durationLimit !== undefined &&
    dailyDurationSeconds + safeDuration > durationLimit
  ) {
    return NextResponse.json(
      {
        error: {
          message: "Daily audio duration limit exceeded",
          code: "DAILY_DURATION_LIMIT_EXCEEDED",
        },
        quota: { count: dailyDurationSeconds, limit: durationLimit },
      },
      { status: 429 },
    );
  }

  return null;
}

export async function POST(request: Request): Promise<Response> {
  initServices();

  // 1. Auth check
  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx || !authCtx.orgId) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  const orgId = authCtx.orgId;

  // 2. Quota check (free tier has a per-user limit; pro/team are unlimited)
  const orgTier = await getOrgTierSafe(orgId);
  const quota = await checkAudioInputQuota(orgId, authCtx.userId, orgTier);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: {
          message:
            "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
          code: "AUDIO_INPUT_QUOTA_EXCEEDED",
        },
        quota: { count: quota.count, limit: quota.limit },
      },
      { status: 402 },
    );
  }

  const apiKey = env().OPENAI_API_KEY;

  // 4. Parse multipart form data
  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    log.warn("STT validation rejected: no file", {
      hasField: file !== null,
      fieldType: typeof file,
    });
    return NextResponse.json(
      { error: { message: "No audio file provided", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // 5. Validate file size
  if (file.size > MAX_FILE_SIZE) {
    log.warn("STT validation rejected: file too large", {
      fileSize: file.size,
      fileMime: file.type,
    });
    return NextResponse.json(
      {
        error: {
          message: "File too large (max 25 MB)",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // 6. Validate file type (strip codec suffix, e.g. "audio/webm;codecs=opus" → "audio/webm")
  const baseMimeType = file.type.split(";")[0] ?? file.type;
  if (!ALLOWED_MIME_TYPES.has(baseMimeType)) {
    log.warn("STT validation rejected: unsupported mime", {
      fileMime: file.type,
      baseMimeType,
      fileSize: file.size,
    });
    return NextResponse.json(
      {
        error: {
          message: `Unsupported audio format: ${baseMimeType}. Supported: webm, wav, mp3, m4a, mp4, mpeg, mpga`,
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  // 7. Parse audio duration and enforce per-request + daily limits.
  // All checks happen BEFORE the OpenAI proxy so abuse costs are zero.
  const durationSeconds = await getAudioDuration(file);
  if (
    durationSeconds !== null &&
    durationSeconds > MAX_REQUEST_DURATION_SECONDS
  ) {
    log.warn("STT validation rejected: duration too long", {
      durationSeconds,
      maxSeconds: MAX_REQUEST_DURATION_SECONDS,
      fileMime: file.type,
      fileSize: file.size,
    });
    return NextResponse.json(
      {
        error: {
          message: `Audio duration (${durationSeconds}s) exceeds maximum (${MAX_REQUEST_DURATION_SECONDS}s)`,
          code: "AUDIO_DURATION_TOO_LONG",
        },
      },
      { status: 400 },
    );
  }

  const dailyLimits = await checkDailyLimits(
    orgId,
    authCtx.userId,
    orgTier,
    durationSeconds,
  );
  if (dailyLimits) return dailyLimits;

  const safeDuration = durationSeconds ?? 0;

  // 8. Call OpenAI STT API
  const openaiForm = new FormData();
  openaiForm.append("file", file, file.name || "audio.webm");
  openaiForm.append("model", "gpt-4o-mini-transcribe");
  openaiForm.append("response_format", "json");

  const openaiResponse = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: openaiForm,
      signal: request.signal,
    },
  );

  if (!openaiResponse.ok) {
    const errorBody = await openaiResponse.text();
    log.error("OpenAI STT API error", {
      status: openaiResponse.status,
      statusText: openaiResponse.statusText,
      body: errorBody,
      fileMime: file.type,
      fileSize: file.size,
      fileName: file.name,
    });
    return NextResponse.json(
      {
        error: {
          message: "Transcription failed",
          code: "INTERNAL_SERVER_ERROR",
        },
      },
      { status: 500 },
    );
  }

  const result = (await openaiResponse.json()) as { text: string };

  // 9. Record daily rate + duration, and legacy free-tier quota.
  // Parallel writes — different behavior keys, no conflict.
  await Promise.all([
    recordBehavior(orgId, authCtx.userId, dailyRateKey()),
    recordBehavior(orgId, authCtx.userId, dailyDurationKey(), safeDuration),
    orgTier === "free"
      ? recordBehavior(orgId, authCtx.userId, AUDIO_INPUT_BEHAVIOR_KEY)
      : Promise.resolve(0),
  ]);

  return NextResponse.json({ text: result.text });
}
