import { command, computed, state } from "ccstate";
import {
  zeroVoiceIoQuotaContract,
  type AudioInputQuotaResponse,
} from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { fetch$ } from "../fetch.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../zero-page/settings/org-manage-tabs-state.ts";
import { setOrgManageDialogOpen$ } from "../zero-page/settings/org-manage-dialog.ts";
import { logger } from "../log.ts";
import { createDeferredPromise, resetSignal } from "../utils.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { stopTts$ } from "./voice-io-tts.ts";
import { accept } from "../../lib/accept.ts";

const L = logger("VoiceIO:STT");

const resetRecord$ = resetSignal();
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

export const audioInputAvailable$ = computed(() => {
  const hasMic =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  return hasMic;
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

async function openMedia(signal: AbortSignal) {
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax -- getUserMedia rejects on permission denied
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    signal.throwIfAborted();
    return stream;
  } catch (error) {
    L.error("Microphone access denied", error);
    toast.error("Microphone access denied");
    return;
  }
}

export const startRecording$ = command(
  async ({ get, set }, parentSignal: AbortSignal) => {
    if (get(internalRecording$) || get(internalTranscribing$)) {
      return;
    }

    set(stopTts$);

    const signal = set(resetRecord$, parentSignal);

    const stream = await openMedia(signal);
    if (!stream) {
      return;
    }

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

    signal.addEventListener("abort", () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      stopAllTracks(stream);
      set(resetState$);
    });

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

    // Collect recorded audio
    const chunks = get(internalChunks$);
    if (chunks.length === 0) {
      set(resetRecord$);
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

    // eslint-disable-next-line no-restricted-syntax -- raw fetch for FormData upload (not a ts-rest contract)
    try {
      const response = await fetchFn("/api/zero/voice-io/stt", {
        method: "POST",
        body: formData,
        signal,
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => {
          return null;
        })) as {
          error?: { code?: string; message?: string };
        } | null;
        const code = body?.error?.code;

        if (response.status === 402 && code === "AUDIO_INPUT_QUOTA_EXCEEDED") {
          set(refreshAudioInputQuota$);
          set(setActiveOrgManageTab$, "billing");
          set(setBillingSubPage$, true);
          await set(setOrgManageDialogOpen$, true, signal);
          return "";
        }

        L.error("STT API error", {
          status: response.status,
          code,
          message: body?.error?.message,
          recordedMime: mimeType,
          recordedSize: blob.size,
        });
        toast.error("Transcription failed");
        return "";
      }

      const result = (await response.json()) as { text: string };
      // Refresh cached quota so the UI reflects the new count for free-tier users.
      set(refreshAudioInputQuota$);
      return result.text.trim();
    } catch (error) {
      L.error("STT fetch failed", error);
      toast.error("Transcription failed");
      return "";
    } finally {
      set(resetRecord$);
    }
  },
);
