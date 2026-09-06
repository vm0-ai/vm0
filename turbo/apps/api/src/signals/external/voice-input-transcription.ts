import type { VoiceInputModel } from "@okouai/api-contracts/contracts/voice-input-models";
import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { readBoundedResponseText, safeJsonParse } from "../utils";
import type { OpenRouterVoiceAudio } from "./openrouter-voice";

type TranscriptionModel = Extract<VoiceInputModel, { kind: "transcription" }>;
const ELEVENLABS_MODEL = "fal-ai/elevenlabs/speech-to-text/scribe-v2";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const transcriptionSchema = z.object({
  text: z.string().trim().max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
});

export class VoiceTranscriptionRequestError extends Error {
  constructor(readonly status: number) {
    super("Voice transcription provider rejected the request");
    this.name = "VoiceTranscriptionRequestError";
  }
}

export function isVoiceTranscriptionConfigured(
  model: TranscriptionModel,
): boolean {
  return model.id === ELEVENLABS_MODEL
    ? Boolean(env("FAL_KEY"))
    : Boolean(optionalEnv("OPENROUTER_API_KEY"));
}

export async function transcribeVoiceInputAudio(
  model: TranscriptionModel,
  audio: OpenRouterVoiceAudio,
  signal: AbortSignal,
): Promise<string> {
  const elevenLabs = model.id === ELEVENLABS_MODEL;
  const key = elevenLabs ? env("FAL_KEY") : optionalEnv("OPENROUTER_API_KEY");
  if (!key) {
    throw new Error("Voice transcription provider is not configured");
  }
  const response = await fetch(
    elevenLabs
      ? `https://fal.run/${ELEVENLABS_MODEL}`
      : "https://openrouter.ai/api/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: `${elevenLabs ? "Key" : "Bearer"} ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        elevenLabs
          ? {
              audio_url: `data:audio/wav;base64,${audio.data}`,
              tag_audio_events: false,
              diarize: false,
            }
          : { model: model.id, input_audio: audio, response_format: "json" },
      ),
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new VoiceTranscriptionRequestError(response.status);
  }
  const body = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
  signal.throwIfAborted();
  if (body.kind !== "text") {
    throw new Error("Voice transcription response exceeds the size limit");
  }
  return transcriptionSchema.parse(safeJsonParse(body.text)).text;
}
