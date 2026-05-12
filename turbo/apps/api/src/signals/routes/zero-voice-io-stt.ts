import { command } from "ccstate";
import { zeroVoiceIoSttContract } from "@vm0/api-contracts/contracts/zero-voice-io-stt";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import { audioInputQuota } from "../services/voice-io.service";
import {
  badRequest,
  getAudioDuration,
  internalError,
  isAllowedSttMimeType,
  isTranscriptionBody,
  MAX_STT_FILE_SIZE,
  MAX_STT_REQUEST_DURATION_SECONDS,
  OPENAI_AUDIO_TRANSCRIPTIONS_URL,
  recordSttUsage$,
  sttDailyPolicy$,
  VOICE_IO_STT_MODEL,
} from "../services/zero-voice-io-post.service";
import { env } from "../../lib/env";

const L = logger("ZeroVoiceIoStt");

const postSttInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const quota = await get(audioInputQuota(auth.orgId, auth.userId));
  signal.throwIfAborted();
  if (!quota.allowed) {
    return {
      status: 402 as const,
      body: {
        error: {
          message:
            "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
          code: "AUDIO_INPUT_QUOTA_EXCEEDED",
        },
        quota: { count: quota.count, limit: quota.limit },
      },
    };
  }

  const request = get(request$);
  const formData = await request.raw.formData();
  signal.throwIfAborted();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    L.warn("STT validation rejected: no file", {
      hasField: file !== null,
      fieldType: typeof file,
    });
    return badRequest("No audio file provided");
  }

  if (file.size > MAX_STT_FILE_SIZE) {
    L.warn("STT validation rejected: file too large", {
      fileSize: file.size,
      fileMime: file.type,
    });
    return badRequest("File too large (max 25 MB)");
  }

  const baseMimeType = file.type.split(";")[0] ?? file.type;
  if (!isAllowedSttMimeType(baseMimeType)) {
    L.warn("STT validation rejected: unsupported mime", {
      fileMime: file.type,
      baseMimeType,
      fileSize: file.size,
    });
    return badRequest(
      `Unsupported audio format: ${baseMimeType}. Supported: webm, wav, mp3, m4a, mp4, mpeg, mpga`,
    );
  }

  const durationSeconds = await getAudioDuration(file);
  signal.throwIfAborted();
  if (
    durationSeconds !== null &&
    durationSeconds > MAX_STT_REQUEST_DURATION_SECONDS
  ) {
    L.warn("STT validation rejected: duration too long", {
      durationSeconds,
      maxSeconds: MAX_STT_REQUEST_DURATION_SECONDS,
      fileMime: file.type,
      fileSize: file.size,
    });
    return badRequest(
      `Audio duration (${durationSeconds}s) exceeds maximum (${MAX_STT_REQUEST_DURATION_SECONDS}s)`,
      "AUDIO_DURATION_TOO_LONG",
    );
  }

  const policy = await set(
    sttDailyPolicy$,
    auth.orgId,
    auth.userId,
    durationSeconds ?? 0,
    signal,
  );
  if ("status" in policy) {
    return policy;
  }

  const openaiForm = new FormData();
  openaiForm.append("file", file, file.name || "audio.webm");
  openaiForm.append("model", VOICE_IO_STT_MODEL);
  openaiForm.append("response_format", "json");

  const openaiResponse = await fetch(OPENAI_AUDIO_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENAI_API_KEY")}` },
    body: openaiForm,
    signal,
  });
  signal.throwIfAborted();

  if (!openaiResponse.ok) {
    const errorBody = await openaiResponse.text();
    signal.throwIfAborted();
    L.error("OpenAI STT API error", {
      status: openaiResponse.status,
      statusText: openaiResponse.statusText,
      body: errorBody,
      fileMime: file.type,
      fileSize: file.size,
      fileName: file.name,
    });
    return internalError("Transcription failed");
  }

  const result: unknown = await openaiResponse.json();
  signal.throwIfAborted();
  if (!isTranscriptionBody(result)) {
    return internalError("Transcription failed");
  }

  await set(
    recordSttUsage$,
    { ...policy, orgId: auth.orgId, userId: auth.userId },
    signal,
  );

  return { status: 200 as const, body: { text: result.text } };
});

export const zeroVoiceIoSttRoutes: readonly RouteEntry[] = [
  {
    route: zeroVoiceIoSttContract.post,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      postSttInner$,
    ),
  },
];
