import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import type {
  VoiceIoTranscribeContext,
  VoiceIoTranscribeSegmentOptions,
  VoiceIoTranscribeSegmentResponse,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import {
  DEFAULT_VOICE_INPUT_MODEL,
  type MultimodalVoiceInputModelId,
  type VoiceInputModel,
} from "@okouai/api-contracts/contracts/voice-input-models";
import { command } from "ccstate";

import { notConfigured } from "../../lib/error";
import { requestSignal$, setResHeader$ } from "../context/hono";
import {
  isLlmConfigured,
  OpenRouterRequestError,
} from "../external/openrouter";
import {
  OPENROUTER_VOICE_NO_SPEECH,
  polishLongVoiceTranscript,
  transcribeVoice,
  finishIncrementalVoice,
  type OpenRouterVoiceAudio,
} from "../external/openrouter-voice";
import {
  isVoiceTranscriptionConfigured,
  transcribeVoiceInputAudio,
  VoiceTranscriptionRequestError,
} from "../external/voice-input-transcription";
import { settle } from "../utils";

type VoiceDraftTranscriptionInput = VoiceIoTranscribeContext &
  VoiceIoTranscribeSegmentOptions & {
    readonly files: readonly File[];
    readonly model: VoiceInputModel;
    readonly debug: boolean;
  };

function voicePolishModel(
  input: VoiceDraftTranscriptionInput,
): MultimodalVoiceInputModelId {
  // GPT Audio requires audio input. Finalization without a remaining audio
  // segment uses the shared text-capable polish model.
  if (
    input.model.kind === "transcription" ||
    (input.files.length === 0 &&
      (input.model.id === "openai/gpt-audio" ||
        input.model.id === "openai/gpt-audio-mini"))
  ) {
    return DEFAULT_VOICE_INPUT_MODEL;
  }
  return input.model.id;
}

function transcriptionError<Status extends number>(
  status: Status,
  code: string,
  message: string,
) {
  return { status, body: { error: { code, message } } } as const;
}

function providerError(error: unknown) {
  if (
    (error instanceof OpenRouterRequestError ||
      error instanceof VoiceTranscriptionRequestError) &&
    (error.status === 429 || error.status >= 500)
  ) {
    return transcriptionError(
      503,
      "PROVIDER_UNAVAILABLE",
      "Voice draft transcription is temporarily unavailable",
    );
  }
  return transcriptionError(
    502,
    "VOICE_TRANSCRIPTION_FAILED",
    "Voice draft transcription failed to produce a usable response",
  );
}

async function voiceAudio(
  file: File,
  signal: AbortSignal,
): Promise<OpenRouterVoiceAudio> {
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  return {
    data: Buffer.from(bytes).toString("base64"),
    format: "wav",
  };
}

function stitchTranscripts(pieces: readonly string[]): string {
  const transcript = pieces
    .map((piece) => {
      return piece.trim();
    })
    .filter((text) => {
      return text !== OPENROUTER_VOICE_NO_SPEECH;
    })
    .join(" ")
    .trim();
  if (transcript.length > VOICE_IO_POLISH_MAX_TEXT_CHARS) {
    throw new Error("Stitched voice transcript is invalid");
  }
  return transcript;
}

async function transcribeIncrementalVoice(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceIoTranscribeSegmentResponse> {
  const file = input.files[0];
  const audio = file ? await voiceAudio(file, signal) : undefined;
  if (audio && input.final && input.model.kind === "multimodal") {
    const result = await finishIncrementalVoice(
      audio,
      input,
      input.model.id,
      signal,
    );
    if (!result) {
      throw new Error("Voice transcription is not configured");
    }
    return {
      ...result,
      transcript:
        result.transcript === OPENROUTER_VOICE_NO_SPEECH
          ? ""
          : result.transcript,
      polishedText:
        result.polishedText === OPENROUTER_VOICE_NO_SPEECH
          ? ""
          : result.polishedText,
    };
  }
  const result = audio
    ? input.model.kind === "transcription"
      ? {
          transcript: await transcribeVoiceInputAudio(
            input.model,
            audio,
            signal,
          ),
          language: "und",
        }
      : await transcribeVoice(audio, input, input.model.id, signal)
    : { transcript: "", language: "und" };
  if (!result) {
    throw new Error("Voice transcription is not configured");
  }
  const transcript =
    result.transcript === OPENROUTER_VOICE_NO_SPEECH ? "" : result.transcript;
  if (!input.final) {
    return { transcript, language: result.language };
  }
  const completeTranscript = stitchTranscripts([
    input.previousTranscript,
    transcript,
  ]);
  if (!completeTranscript) {
    return { transcript, polishedText: "", language: result.language };
  }
  const polished = await polishLongVoiceTranscript(
    completeTranscript,
    input,
    voicePolishModel(input),
    signal,
  );
  if (!polished) {
    throw new Error("Voice transcription is not configured");
  }
  return {
    transcript,
    ...polished,
    polishedText:
      polished.polishedText === OPENROUTER_VOICE_NO_SPEECH
        ? ""
        : polished.polishedText,
  };
}

export const transcribeVoiceSegment$ = command(
  async (
    { get, set },
    input: VoiceDraftTranscriptionInput,
    signal: AbortSignal,
  ) => {
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    if (
      !isLlmConfigured() ||
      (input.model.kind === "transcription" &&
        !isVoiceTranscriptionConfigured(input.model))
    ) {
      return notConfigured("Voice transcription is not configured");
    }
    if (input.debug) {
      set(setResHeader$, "X-Voice-Input-Model", input.model.id);
      if (input.final) {
        set(setResHeader$, "X-Voice-Polish-Model", voicePolishModel(input));
      }
      set(
        setResHeader$,
        "Access-Control-Expose-Headers",
        "Server-Timing, X-Voice-Input-Model, X-Voice-Polish-Model",
        { append: true },
      );
    }
    const startedAt = performance.now();
    const generated = await settle(
      transcribeIncrementalVoice(input, requestSignal),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (
      input.final &&
      (input.previousTranscript.trim() || generated.value.transcript.trim()) &&
      !generated.value.polishedText?.trim()
    ) {
      return providerError(new Error("Voice polish discarded recorded speech"));
    }
    if (input.debug) {
      set(
        setResHeader$,
        "Server-Timing",
        `voice_segment;dur=${(performance.now() - startedAt).toFixed(2)}`,
        { append: true },
      );
    }
    if (
      !generated.value.transcript &&
      (!input.final || !generated.value.polishedText)
    ) {
      return { status: 204 as const, body: undefined };
    }
    return { status: 200 as const, body: generated.value };
  },
);
