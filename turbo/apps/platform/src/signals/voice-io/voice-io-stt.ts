import { command, computed, state } from "ccstate";
import {
  zeroVoiceIoQuotaContract,
  type AudioInputQuotaResponse,
} from "@vm0/core/contracts/zero-voice-io-quota";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { fetch$ } from "../fetch.ts";
import { zeroClient$ } from "../api-client.ts";
import { setBillingDialogOpen$ } from "../zero-page/billing.ts";
import { logger } from "../log.ts";
import { createDeferredPromise } from "../utils.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { stopTts$ } from "./voice-io-tts.ts";
import { accept } from "../../lib/accept.ts";

const L = logger("VoiceIO:STT");

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalRecording$ = state(false);
const internalTranscribing$ = state(false);
const internalStream$ = state<MediaStream | null>(null);
const internalChunks$ = state<Blob[]>([]);
const internalRecorder$ = state<MediaRecorder | null>(null);
const audioInputQuotaReload$ = state(0);

// ---------------------------------------------------------------------------
// Public computed
// ---------------------------------------------------------------------------

export const sttRecording$ = computed((get) => {
  return get(internalRecording$);
});

export const sttTranscribing$ = computed((get) => {
  return get(internalTranscribing$);
});

export const audioInputAvailable$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  const featureEnabled = features[FeatureSwitchKey.AudioInput] ?? false;
  const hasMic =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  return featureEnabled && hasMic;
});

/**
 * Async-loaded audio input quota for the current user/org.
 * Re-fetches whenever `refreshAudioInputQuota$` is invoked (e.g., after a
 * successful STT call or a 402 response).
 */
export const audioInputQuota$ = computed(
  async (get): Promise<AudioInputQuotaResponse> => {
    get(audioInputQuotaReload$);
    const createClient = get(zeroClient$);
    const client = createClient(zeroVoiceIoQuotaContract);
    const result = await accept(client.get(), [200], { toast: false });
    return result.body;
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chooseMimeType(): string {
  if (typeof MediaRecorder !== "undefined") {
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return "audio/webm";
    }
    if (MediaRecorder.isTypeSupported("audio/mp4")) {
      return "audio/mp4";
    }
  }
  return "";
}

function stopAllTracks(stream: MediaStream | null) {
  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
}

// ---------------------------------------------------------------------------
// Internal commands
// ---------------------------------------------------------------------------

const resetState$ = command(({ set }) => {
  set(internalRecording$, false);
  set(internalTranscribing$, false);
  set(internalChunks$, []);
  set(internalRecorder$, null);
  set(internalStream$, null);
});

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

const refreshAudioInputQuota$ = command(({ set }) => {
  set(audioInputQuotaReload$, (x) => {
    return x + 1;
  });
});

export const startRecording$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (get(internalRecording$) || get(internalTranscribing$)) {
      return;
    }

    // Stop any ongoing TTS playback to prevent recording AI voice
    set(stopTts$);

    let stream: MediaStream;
    // eslint-disable-next-line no-restricted-syntax -- getUserMedia rejects on permission denied
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      L.error("Microphone access denied", error);
      toast.error("Microphone access denied");
      return;
    }
    signal.throwIfAborted();

    const mimeType = chooseMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    set(internalChunks$, []);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        const prev = get(internalChunks$);
        set(internalChunks$, [...prev, event.data]);
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

    // Stop recording and wait for final data
    if (recorder && recorder.state !== "inactive") {
      const stopDeferred = createDeferredPromise<void>(signal);
      recorder.addEventListener(
        "stop",
        () => {
          stopDeferred.resolve();
        },
        { once: true, signal },
      );
      recorder.stop();
      await stopDeferred.promise;
    }

    set(internalRecording$, false);

    // Release mic hardware
    stopAllTracks(stream);

    // Collect recorded audio
    const chunks = get(internalChunks$);
    if (chunks.length === 0) {
      set(resetState$);
      return "";
    }

    const mimeType = recorder?.mimeType ?? "audio/webm";
    const blob = new Blob(chunks, { type: mimeType });

    set(internalTranscribing$, true);

    // Send to STT endpoint
    const fetchFn = get(fetch$);
    const formData = new FormData();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    formData.append("file", blob, `recording.${extension}`);

    let text = "";
    // eslint-disable-next-line no-restricted-syntax -- raw fetch for FormData upload (not a ts-rest contract)
    try {
      const response = await fetchFn("/api/zero/voice-io/stt", {
        method: "POST",
        body: formData,
        signal,
      });

      if (!response.ok) {
        if (response.status === 402) {
          const body = (await response.json().catch(() => {
            return null;
          })) as {
            error?: { code?: string };
          } | null;
          if (body?.error?.code === "AUDIO_INPUT_QUOTA_EXCEEDED") {
            set(refreshAudioInputQuota$);
            set(setBillingDialogOpen$, true);
            set(resetState$);
            return "";
          }
        }
        L.error("STT API error", { status: response.status });
        toast.error("Transcription failed");
        set(resetState$);
        return "";
      }

      const result = (await response.json()) as { text: string };
      text = result.text.trim();
      // Refresh cached quota so the UI reflects the new count for free-tier users.
      set(refreshAudioInputQuota$);
    } catch (error) {
      L.error("STT fetch failed", error);
      toast.error("Transcription failed");
      set(resetState$);
      return "";
    }

    set(resetState$);
    return text;
  },
);
