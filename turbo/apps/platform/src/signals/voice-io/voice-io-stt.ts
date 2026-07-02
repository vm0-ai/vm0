import { command, computed, state } from "ccstate";
import { delay } from "signal-timers";
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
import { createDeferredPromise, resetSignal, settle } from "../utils.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../lib/accept.ts";
import { now as currentTimeMs } from "../../lib/time.ts";
import { resolveAudioConfig } from "../../lib/voice-io/audio-config.ts";

const L = logger("VoiceIO:STT");

const resetRecord$ = resetSignal();
// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalRecording$ = state(false);
const internalStarting$ = state(false);
const internalTranscribing$ = state(false);
const internalSpeechDetected$ = state(false);
const internalVoiceLevel$ = state(0);
const internalVoiceDetectedDuringRecording$ = state(false);
const internalVoiceActivityAvailable$ = state(false);
const internalVoiceActivityCoversRecording$ = state(false);
const internalStream$ = state<MediaStream | null>(null);
const internalChunks$ = state<Blob[]>([]);
const internalRecorder$ = state<MediaRecorder | null>(null);
const internalAudioActivityMonitor$ = state<AudioActivityMonitor | null>(null);
const audioInputQuotaReload$ = state(0);

// ---------------------------------------------------------------------------
// Public computed
// ---------------------------------------------------------------------------

export const sttRecording$ = computed((get) => {
  return get(internalRecording$);
});

export const sttStarting$ = computed((get) => {
  return get(internalStarting$);
});

export const sttTranscribing$ = computed((get) => {
  return get(internalTranscribing$);
});

export const sttSpeechDetected$ = computed((get) => {
  return get(internalSpeechDetected$);
});

export const sttVoiceLevel$ = computed((get) => {
  return get(internalVoiceLevel$);
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
    const result = await accept(client.get(), [200]);
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

const VOICE_ACTIVITY_RMS_THRESHOLD = 0.025;
const VOICE_ACTIVITY_HOLD_MS = 300;
const VOICE_ACTIVITY_START_GRACE_MS = 500;

interface VoiceActivity {
  readonly detected: boolean;
  readonly level: number;
}

type VoiceActivityCallback = (activity: VoiceActivity) => void;

interface AudioActivityTracker {
  handle(samples: Float32Array<ArrayBufferLike>): void;
  reset(): void;
}

interface AudioActivityMonitor {
  readonly audioContext: AudioContext;
  readonly source: MediaStreamAudioSourceNode;
  readonly analyser: AnalyserNode;
  readonly samples: Float32Array<ArrayBuffer>;
  readonly tracker: AudioActivityTracker;
  readonly cancelFrame: (handle: number) => void;
  frameId: number | null;
  stopped: boolean;
}

function audioActivityNow(): number {
  return typeof performance !== "undefined"
    ? performance.now()
    : currentTimeMs();
}

function waitForBrowserPaint(signal: AbortSignal): Promise<void> {
  if (
    typeof window === "undefined" ||
    typeof window.requestAnimationFrame !== "function" ||
    typeof window.cancelAnimationFrame !== "function"
  ) {
    return Promise.resolve();
  }

  const deferred = createDeferredPromise<void>(signal);
  let firstFrameId: number | null = null;
  let secondFrameId: number | null = null;

  function cleanup(): void {
    signal.removeEventListener("abort", handleAbort);
  }

  function finish(): void {
    cleanup();
    if (!deferred.settled()) {
      deferred.resolve(undefined);
    }
  }

  function handleAbort(): void {
    if (firstFrameId !== null) {
      window.cancelAnimationFrame(firstFrameId);
    }
    if (secondFrameId !== null) {
      window.cancelAnimationFrame(secondFrameId);
    }
    finish();
  }

  signal.addEventListener("abort", handleAbort, { once: true });
  firstFrameId = window.requestAnimationFrame(() => {
    secondFrameId = window.requestAnimationFrame(finish);
  });
  return deferred.promise;
}

function rms(samples: Float32Array<ArrayBufferLike>): number {
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function voiceActivityLevel(value: number): number {
  if (value < VOICE_ACTIVITY_RMS_THRESHOLD) {
    return 0;
  }
  if (value < 0.055) {
    return 1;
  }
  if (value < 0.095) {
    return 2;
  }
  return 3;
}

function createAudioActivityTracker(
  onActivity: VoiceActivityCallback,
): AudioActivityTracker {
  let active = false;
  let level = 0;
  let lastSpeechAt = 0;

  return {
    handle(samples: Float32Array<ArrayBufferLike>): void {
      const now = audioActivityNow();
      const nextRms = rms(samples);
      if (nextRms >= VOICE_ACTIVITY_RMS_THRESHOLD) {
        lastSpeechAt = now;
      }

      const nextActive =
        lastSpeechAt > 0 && now - lastSpeechAt <= VOICE_ACTIVITY_HOLD_MS;
      const nextLevel = voiceActivityLevel(nextRms);
      if (nextActive !== active || nextLevel !== level) {
        active = nextActive;
        level = nextLevel;
        onActivity({ detected: nextActive, level: nextLevel });
      }
    },
    reset(): void {
      lastSpeechAt = 0;
      if (active || level !== 0) {
        active = false;
        level = 0;
        onActivity({ detected: false, level: 0 });
      }
    },
  };
}

async function closeAudioContextQuietly(
  audioContext: AudioContext,
): Promise<void> {
  const result = await settle(audioContext.close());
  if (!result.ok) {
    L.error("Audio activity monitor close failed", result.error);
  }
}

async function startAudioActivityMonitor(
  stream: MediaStream,
  onActivity: VoiceActivityCallback,
  signal: AbortSignal,
): Promise<AudioActivityMonitor | null> {
  const AudioContextConstructor = audioContextConstructor();
  if (!AudioContextConstructor) {
    return null;
  }

  const audioContext = new AudioContextConstructor();
  if (
    typeof audioContext.createMediaStreamSource !== "function" ||
    typeof audioContext.createAnalyser !== "function"
  ) {
    await closeAudioContextQuietly(audioContext);
    return null;
  }

  await audioContext.resume();
  if (signal.aborted) {
    await closeAudioContextQuietly(audioContext);
    signal.throwIfAborted();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  const requestFrame = window.requestAnimationFrame.bind(window);
  analyser.fftSize = 1024;
  source.connect(analyser);

  const monitor: AudioActivityMonitor = {
    audioContext,
    source,
    analyser,
    samples: new Float32Array(analyser.fftSize),
    tracker: createAudioActivityTracker(onActivity),
    cancelFrame: window.cancelAnimationFrame.bind(window),
    frameId: null,
    stopped: false,
  };

  const update = () => {
    if (monitor.stopped) {
      return;
    }
    monitor.analyser.getFloatTimeDomainData(monitor.samples);
    monitor.tracker.handle(monitor.samples);
    monitor.frameId = requestFrame(update);
  };

  monitor.frameId = requestFrame(update);
  return monitor;
}

function stopAudioActivityMonitor(monitor: AudioActivityMonitor): void {
  if (monitor.stopped) {
    return;
  }

  monitor.stopped = true;
  if (monitor.frameId !== null) {
    monitor.cancelFrame(monitor.frameId);
    monitor.frameId = null;
  }
  monitor.tracker.reset();
  monitor.source.disconnect();
  monitor.analyser.disconnect();
}

function isAudioInputQuotaExceeded(failure: SttApiFailure): boolean {
  return (
    failure.status === 402 && failure.code === "AUDIO_INPUT_QUOTA_EXCEEDED"
  );
}

function logSttFailure(
  failure: SttApiFailure,
  context: Record<string, unknown>,
): void {
  L.error("STT API error", {
    status: failure.status,
    code: failure.code,
    message: failure.message,
    ...context,
  });
  toast.error("Transcription failed");
}

// ---------------------------------------------------------------------------
// Internal commands
// ---------------------------------------------------------------------------

const resetState$ = command(({ set }) => {
  set(internalRecording$, false);
  set(internalStarting$, false);
  set(internalTranscribing$, false);
  set(internalSpeechDetected$, false);
  set(internalVoiceLevel$, 0);
  set(internalVoiceDetectedDuringRecording$, false);
  set(internalVoiceActivityAvailable$, false);
  set(internalVoiceActivityCoversRecording$, false);
  set(internalChunks$, []);
  set(internalRecorder$, null);
  set(internalAudioActivityMonitor$, null);
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

interface SttApiFailure {
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
}

type SttApiResult =
  | { readonly ok: true; readonly text: string }
  | ({ readonly ok: false } & SttApiFailure);

interface WindowWithWebkitAudioContext extends Window {
  readonly webkitAudioContext?: typeof AudioContext;
}

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (
    window.AudioContext ??
    (window as WindowWithWebkitAudioContext).webkitAudioContext
  );
}

function createMediaRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = chooseMimeType();
  return mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
}

async function readSttApiResponse(
  response: Response,
  signal: AbortSignal,
): Promise<SttApiResult> {
  if (!response.ok) {
    const settled = await settle(response.json());
    signal.throwIfAborted();
    const body = settled.ok
      ? (settled.value as {
          error?: { code?: string; message?: string };
        } | null)
      : null;
    return {
      ok: false,
      status: response.status,
      code: body?.error?.code,
      message: body?.error?.message,
    };
  }

  const result = (await response.json()) as { text: string };
  signal.throwIfAborted();
  return { ok: true, text: result.text.trim() };
}

async function openMedia(signal: AbortSignal) {
  const audioConfig = await resolveAudioConfig();
  signal.throwIfAborted();
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax -- getUserMedia rejects on permission denied
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConfig.constraints,
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
    if (
      get(internalStarting$) ||
      get(internalRecording$) ||
      get(internalTranscribing$)
    ) {
      return;
    }

    const signal = set(resetRecord$, parentSignal);
    signal.addEventListener(
      "abort",
      () => {
        set(resetState$);
      },
      { once: true },
    );
    set(internalStarting$, true);
    set(internalSpeechDetected$, false);
    set(internalVoiceLevel$, 0);
    set(internalVoiceDetectedDuringRecording$, false);
    set(internalVoiceActivityAvailable$, false);
    set(internalVoiceActivityCoversRecording$, false);

    await waitForBrowserPaint(signal);
    await delay(0, { signal });
    signal.throwIfAborted();

    const streamResult = await settle(openMedia(signal), signal);
    if (!streamResult.ok) {
      L.error("Microphone start failed", streamResult.error);
      toast.error("Microphone access denied");
      set(internalStarting$, false);
      return;
    }
    const stream = streamResult.value;
    if (!stream) {
      set(internalStarting$, false);
      return;
    }

    set(internalStarting$, false);
    const recorder = createMediaRecorder(stream);
    let audioActivityMonitor: AudioActivityMonitor | null = null;

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
      if (audioActivityMonitor) {
        stopAudioActivityMonitor(audioActivityMonitor);
      }
      stopAllTracks(stream);
      set(resetState$);
    });

    recorder.start();
    const recordingStartedAt = audioActivityNow();
    set(internalRecording$, true);
    set(internalStream$, stream);
    set(internalRecorder$, recorder);
    const audioActivityMonitorResult = await settle(
      startAudioActivityMonitor(
        stream,
        (activity) => {
          set(internalSpeechDetected$, activity.detected);
          set(internalVoiceLevel$, activity.level);
          if (activity.level > 0) {
            set(internalVoiceDetectedDuringRecording$, true);
          }
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!audioActivityMonitorResult.ok) {
      L.error(
        "Audio activity monitor start failed",
        audioActivityMonitorResult.error,
      );
      set(internalVoiceActivityAvailable$, false);
      return;
    }
    audioActivityMonitor = audioActivityMonitorResult.value;
    const monitorStartedAt = audioActivityNow();
    set(internalAudioActivityMonitor$, audioActivityMonitor);
    set(internalVoiceActivityAvailable$, audioActivityMonitor !== null);
    set(
      internalVoiceActivityCoversRecording$,
      monitorStartedAt - recordingStartedAt <= VOICE_ACTIVITY_START_GRACE_MS,
    );
  },
);

export const stopAndTranscribe$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<string> => {
    if (!get(internalRecording$)) {
      return "";
    }

    const recorder = get(internalRecorder$);
    const cancelSilentRecording =
      get(internalVoiceActivityAvailable$) &&
      get(internalVoiceActivityCoversRecording$) &&
      !get(internalVoiceDetectedDuringRecording$);
    const audioActivityMonitor = get(internalAudioActivityMonitor$);
    if (audioActivityMonitor) {
      stopAudioActivityMonitor(audioActivityMonitor);
      await closeAudioContextQuietly(audioActivityMonitor.audioContext);
      signal.throwIfAborted();
      set(internalAudioActivityMonitor$, null);
      set(internalSpeechDetected$, false);
      set(internalVoiceLevel$, 0);
    }

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
    if (cancelSilentRecording) {
      set(resetRecord$);
      return "";
    }

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

    // eslint-disable-next-line no-restricted-syntax -- raw fetch for FormData upload (not a typed contract)
    try {
      const response = await fetchFn("/api/zero/voice-io/stt", {
        method: "POST",
        body: formData,
        signal,
      });

      const result = await readSttApiResponse(response, signal);
      if (!result.ok) {
        if (isAudioInputQuotaExceeded(result)) {
          set(refreshAudioInputQuota$);
          set(setActiveOrgManageTab$, "billing");
          set(setBillingSubPage$, true);
          await set(setOrgManageDialogOpen$, true, signal);
          return "";
        }

        logSttFailure(result, {
          recordedMime: mimeType,
          recordedSize: blob.size,
        });
        return "";
      }

      // Refresh cached quota so the UI reflects the new count for free-tier users.
      set(refreshAudioInputQuota$);
      return result.text;
    } catch (error) {
      L.error("STT fetch failed", error);
      toast.error("Transcription failed");
      return "";
    } finally {
      set(resetRecord$);
    }
  },
);
