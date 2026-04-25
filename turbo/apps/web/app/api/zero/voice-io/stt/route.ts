import { NextResponse } from "next/server";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/api-contracts/feature-switch-key";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { initServices } from "../../../../../src/lib/init-services";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";
import { getOrgTierSafe } from "../../../../../src/lib/zero/org/org-metadata-service";
import { recordBehavior } from "../../../../../src/lib/zero/behavior/user-behavior-count-service";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  checkAudioInputQuota,
} from "../../../../../src/lib/zero/voice-io/audio-input-policy";
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

  // 2. Feature switch check
  const overrides = await loadFeatureSwitchOverrides(
    authCtx.orgId,
    authCtx.userId,
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.AudioInput, {
    orgId: authCtx.orgId,
    userId: authCtx.userId,
    overrides,
  });
  if (!enabled) {
    return NextResponse.json(
      { error: { message: "Audio input is not enabled", code: "FORBIDDEN" } },
      { status: 403 },
    );
  }

  // 3. Quota check (free tier has a per-user limit; pro/team are unlimited)
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
    return NextResponse.json(
      { error: { message: "No audio file provided", code: "BAD_REQUEST" } },
      { status: 400 },
    );
  }

  // 5. Validate file size
  if (file.size > MAX_FILE_SIZE) {
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

  // 7. Call OpenAI STT API
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

  // 8. Record the successful audio input for free-tier quota accounting.
  // Skipped on failure so infra errors don't burn the user's free quota.
  if (orgTier === "free") {
    await recordBehavior(orgId, authCtx.userId, AUDIO_INPUT_BEHAVIOR_KEY);
  }

  return NextResponse.json({ text: result.text });
}
