import { z } from "zod";

/** Explicit provider IDs used by voice input and benchmark records. */
export const VOICE_INPUT_MODELS = [
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    kind: "multimodal",
  },
  {
    id: "google/gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash-Lite",
    kind: "multimodal",
  },
  {
    id: "google/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    kind: "multimodal",
  },
  {
    id: "google/gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    kind: "multimodal",
  },
  { id: "openai/gpt-audio", label: "OpenAI GPT Audio", kind: "multimodal" },
  {
    id: "openai/gpt-audio-mini",
    label: "OpenAI GPT Audio Mini",
    kind: "multimodal",
  },
  {
    id: "qwen/qwen3-asr-flash-2026-02-10",
    label: "Qwen3 ASR Flash",
    kind: "transcription",
  },
  { id: "qwen/qwen3-asr-1.7b", label: "Qwen3 ASR 1.7B", kind: "transcription" },
  { id: "qwen/qwen3-asr-0.6b", label: "Qwen3 ASR 0.6B", kind: "transcription" },
  {
    id: "openai/gpt-transcribe",
    label: "OpenAI GPT Transcribe",
    kind: "transcription",
  },
  {
    id: "openai/gpt-4o-transcribe",
    label: "OpenAI GPT-4o Transcribe",
    kind: "transcription",
  },
  {
    id: "openai/gpt-4o-mini-transcribe",
    label: "OpenAI GPT-4o Mini Transcribe",
    kind: "transcription",
  },
  {
    id: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
    label: "ElevenLabs Scribe v2",
    kind: "transcription",
  },
] as const;

export type VoiceInputModel = (typeof VOICE_INPUT_MODELS)[number];
export type VoiceInputModelId = VoiceInputModel["id"];
export type MultimodalVoiceInputModelId = Extract<
  VoiceInputModel,
  { kind: "multimodal" }
>["id"];

export const voiceInputModelIdSchema = z.enum(
  VOICE_INPUT_MODELS.map((model) => {
    return model.id;
  }),
);

export const DEFAULT_VOICE_INPUT_MODEL =
  "google/gemini-3.6-flash" satisfies MultimodalVoiceInputModelId;
