import { command } from "ccstate";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { zeroVoiceIoSpeechContract } from "@vm0/api-contracts/contracts/zero-voice-io-speech";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route";
import {
  badGateway,
  badRequest,
  checkSpeechCredits$,
  insufficientCredits,
  internalError,
  isSpeechVoice,
  OPENAI_AUDIO_SPEECH_URL,
  parseSpeechWavDurationSeconds,
  recordGeneratedSpeech$,
  serviceUnavailable,
  SPEECH_MAX_INPUT_TOKENS,
  SPEECH_RESPONSE_FORMAT,
  speechPricing$,
  VOICE_IO_TTS_MODEL,
} from "../services/zero-voice-io-post.service";
import { env } from "../../lib/env";

const L = logger("ZeroVoiceIoSpeech");
const speechBody$ = bodyResultOf(zeroVoiceIoSpeechContract.post);

const postSpeechInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(speechBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const text =
    typeof bodyResult.data.text === "string" ? bodyResult.data.text.trim() : "";
  if (text.length === 0) {
    return badRequest("text is required");
  }

  const voice =
    typeof bodyResult.data.voice === "string" ? bodyResult.data.voice : "marin";
  if (!isSpeechVoice(voice)) {
    return badRequest(`Unsupported voice: ${voice}`);
  }

  const instructions =
    typeof bodyResult.data.instructions === "string" &&
    bodyResult.data.instructions.trim().length > 0
      ? bodyResult.data.instructions.trim()
      : undefined;
  const tokenCount = encode(`${instructions ?? ""}\n${text}`).length;
  if (tokenCount > SPEECH_MAX_INPUT_TOKENS) {
    return badRequest(
      `text and instructions exceed ${SPEECH_MAX_INPUT_TOKENS} input tokens`,
    );
  }

  const hasCredits = await set(
    checkSpeechCredits$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  if (!hasCredits) {
    return insufficientCredits();
  }

  const pricing = await get(speechPricing$);
  signal.throwIfAborted();
  if (!pricing) {
    return serviceUnavailable(
      "Audio generation pricing is not configured",
      "NOT_CONFIGURED",
    );
  }

  const openaiResponse = await fetch(OPENAI_AUDIO_SPEECH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOICE_IO_TTS_MODEL,
      voice,
      input: text,
      ...(instructions ? { instructions } : {}),
      response_format: SPEECH_RESPONSE_FORMAT,
    }),
    signal,
  });
  signal.throwIfAborted();

  if (!openaiResponse.ok) {
    const errorBody = await openaiResponse.text();
    signal.throwIfAborted();
    L.error("OpenAI speech request failed", {
      status: openaiResponse.status,
      body: errorBody,
    });
    return internalError("Speech generation failed");
  }

  const audioBytes = new Uint8Array(await openaiResponse.arrayBuffer());
  signal.throwIfAborted();
  if (audioBytes.byteLength === 0) {
    return badGateway("Model returned empty audio", "NO_AUDIO_RETURNED");
  }

  const durationSeconds = parseSpeechWavDurationSeconds(audioBytes);
  if (durationSeconds === null) {
    L.error("Unable to parse generated WAV duration", {
      byteLength: audioBytes.byteLength,
    });
    return badGateway(
      "Could not determine generated audio duration",
      "AUDIO_DURATION_UNKNOWN",
    );
  }

  const runId =
    auth.tokenType === "zero" || auth.tokenType === "sandbox"
      ? auth.runId
      : undefined;
  const result = await set(
    recordGeneratedSpeech$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      runId,
      voice,
      audioBytes,
      durationSeconds,
      pricing,
    },
    signal,
  );

  return { status: 200 as const, body: result };
});

export const zeroVoiceIoSpeechRoutes: readonly RouteEntry[] = [
  {
    route: zeroVoiceIoSpeechContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postSpeechInner$,
    ),
  },
];
