import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import type {
  VoiceIoTranscribeContext,
  VoiceIoTranscribeResponse,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import {
  DEFAULT_VOICE_INPUT_MODEL,
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
  transcribeAndPolishVoice,
  transcribeVoice,
  type OpenRouterVoiceAudio,
} from "../external/openrouter-voice";
import {
  isVoiceTranscriptionConfigured,
  transcribeVoiceInputAudio,
  VoiceTranscriptionRequestError,
} from "../external/voice-input-transcription";
import { settle } from "../utils";

const MAX_CONCURRENT_VOICE_TRANSCRIPTIONS = 3;

interface VoiceDraftTranscriptionInput extends VoiceIoTranscribeContext {
  readonly files: readonly File[];
  readonly longRecording: boolean;
  readonly model: VoiceInputModel;
  readonly debug: boolean;
}

interface VoiceDraftResult {
  readonly body: VoiceIoTranscribeResponse | null;
  readonly transcriptionMs: number;
  readonly polishMs: number;
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

async function mapWithConcurrency<T, Result>(
  values: readonly T[],
  maximumConcurrency: number,
  signal: AbortSignal,
  map: (value: T, signal: AbortSignal) => Promise<Result>,
): Promise<readonly Result[]> {
  const results: (Result | undefined)[] = Array.from({
    length: values.length,
  });
  const batchController = new AbortController();
  const batchSignal = AbortSignal.any([signal, batchController.signal]);
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        firstError = new Error("Voice transcription worker received no input");
        failed = true;
        batchController.abort(firstError);
        return;
      }
      const [outcome] = await Promise.allSettled([map(value, batchSignal)]);
      if (!outcome) {
        firstError = new Error("Voice transcription worker did not settle");
        failed = true;
        batchController.abort(firstError);
        return;
      }
      if (outcome.status === "rejected") {
        if (!failed) {
          firstError = outcome.reason;
          failed = true;
          batchController.abort(firstError);
        }
        return;
      }
      results[index] = outcome.value;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maximumConcurrency, values.length) }, worker),
  );
  signal.throwIfAborted();
  if (failed) {
    throw firstError;
  }
  return results.map((result) => {
    if (result === undefined) {
      throw new Error("Voice transcription worker returned no result");
    }
    return result;
  });
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

async function transcribeThenPolishVoiceDraft(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceDraftResult> {
  const startedAt = performance.now();
  const pieces = await mapWithConcurrency(
    input.files,
    MAX_CONCURRENT_VOICE_TRANSCRIPTIONS,
    signal,
    async (file, workerSignal) => {
      const audio = await voiceAudio(file, workerSignal);
      if (input.model.kind === "transcription") {
        return await transcribeVoiceInputAudio(
          input.model,
          audio,
          workerSignal,
        );
      }
      const result = await transcribeVoice(
        audio,
        input,
        input.model.id,
        workerSignal,
      );
      if (result === null) {
        throw new Error("OpenRouter voice transcription is not configured");
      }
      return result.transcript;
    },
  );
  signal.throwIfAborted();
  const transcript = stitchTranscripts(pieces);
  const transcriptionMs = performance.now() - startedAt;
  if (!transcript) {
    return { body: null, transcriptionMs, polishMs: 0 };
  }
  const polishStartedAt = performance.now();
  const polished = await polishLongVoiceTranscript(
    transcript,
    input,
    input.model.kind === "multimodal"
      ? input.model.id
      : DEFAULT_VOICE_INPUT_MODEL,
    signal,
  );
  if (polished === null) {
    throw new Error("OpenRouter voice transcription is not configured");
  }
  return {
    body: {
      transcript,
      polishedText: polished.polishedText,
      language: polished.language,
    },
    transcriptionMs,
    polishMs: performance.now() - polishStartedAt,
  };
}

async function transcribeShortVoiceDraft(
  input: VoiceDraftTranscriptionInput,
  signal: AbortSignal,
): Promise<VoiceDraftResult> {
  if (input.model.kind !== "multimodal") {
    throw new Error("Combined voice transcription requires a multimodal model");
  }
  const startedAt = performance.now();
  const file = input.files[0];
  if (!file) {
    throw new Error("Voice draft transcription requires one audio file");
  }
  const audio = await voiceAudio(file, signal);
  const result = await transcribeAndPolishVoice(
    audio,
    input,
    input.model.id,
    signal,
  );
  if (result === null) {
    throw new Error("OpenRouter voice transcription is not configured");
  }
  return {
    body: result,
    transcriptionMs: performance.now() - startedAt,
    polishMs: 0,
  };
}

export const transcribeVoiceDraft$ = command(
  async (
    { get, set },
    input: VoiceDraftTranscriptionInput,
    signal: AbortSignal,
  ) => {
    const requestSignal = AbortSignal.any([signal, get(requestSignal$)]);
    requestSignal.throwIfAborted();
    if (!isLlmConfigured()) {
      return notConfigured("Voice draft transcription is not configured");
    }
    if (
      input.model.kind === "transcription" &&
      !isVoiceTranscriptionConfigured(input.model)
    ) {
      return notConfigured(
        "The selected voice transcription provider is not configured",
      );
    }

    const combined = !input.longRecording && input.model.kind === "multimodal";
    if (input.debug) {
      set(setResHeader$, "X-Voice-Input-Model", input.model.id);
      set(
        setResHeader$,
        "X-Voice-Polish-Model",
        input.model.kind === "multimodal"
          ? input.model.id
          : DEFAULT_VOICE_INPUT_MODEL,
      );
      set(
        setResHeader$,
        "Access-Control-Expose-Headers",
        "Server-Timing, X-Voice-Input-Model, X-Voice-Polish-Model",
        { append: true },
      );
    }

    const generated = await settle(
      combined
        ? transcribeShortVoiceDraft(input, requestSignal)
        : transcribeThenPolishVoiceDraft(input, requestSignal),
    );
    signal.throwIfAborted();
    if (!generated.ok) {
      return providerError(generated.error);
    }
    if (input.debug) {
      const { transcriptionMs, polishMs } = generated.value;
      const timing = combined
        ? `voice_combined;dur=${transcriptionMs.toFixed(2)}`
        : `voice_transcribe;dur=${transcriptionMs.toFixed(2)}, voice_polish;dur=${polishMs.toFixed(2)}`;
      set(setResHeader$, "Server-Timing", timing, { append: true });
    }
    const body = generated.value.body;
    if (
      body === null ||
      body.transcript === OPENROUTER_VOICE_NO_SPEECH ||
      body.polishedText === OPENROUTER_VOICE_NO_SPEECH
    ) {
      return { status: 204 as const, body: undefined };
    }
    return { status: 200 as const, body };
  },
);
