import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@vm0/core";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { fetch$ } from "../fetch.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { stopTts$ } from "./voice-io-tts.ts";

// ── Private state ──

const internalRecording$ = state(false);
const internalTranscribing$ = state(false);
const internalStream$ = state<MediaStream | null>(null);
const internalChunks$ = state<Blob[]>([]);
const internalRecorder$ = state<MediaRecorder | null>(null);

// ── Public computed (read-only) ──

export const sttRecording$ = computed((get) => {
  return get(internalRecording$);
});
export const sttTranscribing$ = computed((get) => {
  return get(internalTranscribing$);
});

export const voiceIOAvailable$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  const featureEnabled = features[FeatureSwitchKey.VoiceIO] ?? false;
  const hasMic =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  return featureEnabled && hasMic;
});

// ── Helpers ──

function getPreferredMimeType(): string {
  if (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported("audio/webm")
  ) {
    return "audio/webm";
  }
  if (
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported("audio/mp4")
  ) {
    return "audio/mp4";
  }
  return "";
}

function stopAllTracks(stream: MediaStream | null) {
  if (!stream) {
    return;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

// ── Commands ──

export const startRecording$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Guard: if already recording or transcribing, return
    if (get(internalRecording$) || get(internalTranscribing$)) {
      return;
    }

    // Stop any ongoing TTS playback to prevent recording AI voice
    set(stopTts$);

    const stream = await navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .catch(() => {
        return null;
      });
    signal.throwIfAborted();

    if (!stream) {
      toast.error("Microphone access denied");
      return;
    }

    const mimeType = getPreferredMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );

    set(internalChunks$, []);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        set(internalChunks$, [...get(internalChunks$), event.data]);
      }
    };

    recorder.start();
    set(internalRecording$, true);
    set(internalStream$, stream);
    set(internalRecorder$, recorder);
  },
);

export const stopAndTranscribe$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<string> => {
    if (!get(internalRecording$)) {
      return "";
    }

    const recorder = get(internalRecorder$);
    const stream = get(internalStream$);

    set(internalRecording$, false);

    // Wait for MediaRecorder to stop and flush final data
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener(
          "stop",
          () => {
            return resolve();
          },
          { once: true },
        );
        recorder.stop();
      });
    }

    const chunks = get(internalChunks$);
    stopAllTracks(stream);

    if (chunks.length === 0) {
      set(internalRecording$, false);
      set(internalTranscribing$, false);
      set(internalStream$, null);
      set(internalChunks$, []);
      set(internalRecorder$, null);
      return "";
    }

    const mimeType = chunks[0]?.type || "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });

    set(internalTranscribing$, true);
    set(internalStream$, null);
    set(internalChunks$, []);
    set(internalRecorder$, null);

    const formData = new FormData();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    formData.append("file", blob, `recording.${extension}`);

    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/zero/voice-io/stt", {
      method: "POST",
      body: formData,
      signal,
    }).catch(() => {
      return null;
    });
    signal.throwIfAborted();

    if (!response || !response.ok) {
      const errorBody = response
        ? ((await response.json().catch(() => {
            return null;
          })) as { error?: { message?: string } } | null)
        : null;
      const message = errorBody?.error?.message || "Transcription failed";
      toast.error(message);
      set(internalTranscribing$, false);
      return "";
    }

    const result = (await response.json()) as { text: string };
    set(internalTranscribing$, false);
    return (result.text ?? "").trim();
  },
);
