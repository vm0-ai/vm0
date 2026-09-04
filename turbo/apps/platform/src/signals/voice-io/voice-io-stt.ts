import { command, computed, state } from "ccstate";
import { timeout } from "signal-timers";
import {
  voiceIoQuotaContract,
  type AudioInputQuotaResponse,
} from "@okouai/api-contracts/contracts/voice-io-quota";
import { fetch$ } from "../fetch.ts";
import { pageSignal$ } from "../page-signal.ts";
import { isOrgAdmin$ } from "../org.ts";
import { apiClient$ } from "../api-client.ts";
import {
  apiTierToBillingTier,
  billingStatusAsync$,
  type BillingTier,
} from "../okou-page/billing.ts";
import { setBillingSubPage$ } from "../okou-page/settings/workspace-settings-state.ts";
import { openSettingsDialogAt$ } from "../okou-page/settings/settings-dialog.ts";
import { logger } from "../log.ts";
import {
  bestEffort,
  createDeferredPromise,
  jsonParseOr,
  resetSignal,
  settle,
  tapError,
  withCleanup,
} from "../utils.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { accept } from "../../lib/accept.ts";
import { IN_VITEST } from "../../env.ts";
import { now as currentTimeMs } from "../../lib/time.ts";
import { resolveAudioConfig } from "../../lib/voice-io/audio-config.ts";
import { i18n } from "../../i18n/index.ts";

const L = logger("VoiceIO:STT");

const resetRecord$ = resetSignal();
const resetVoiceSilenceTimer$ = resetSignal();
const VOICE_LEVEL_SAMPLE_COUNT = 32;
const VOICE_LEVEL_SAMPLE_INTERVAL_MS = 100;

export interface VoiceLevelSample {
  readonly id: number;
  readonly level: number;
}

interface VoiceLevelHistory {
  readonly nextId: number;
  readonly samples: readonly VoiceLevelSample[];
}

function initialVoiceLevelHistory(): VoiceLevelHistory {
  return {
    nextId: VOICE_LEVEL_SAMPLE_COUNT,
    samples: Array.from({ length: VOICE_LEVEL_SAMPLE_COUNT }, (_, id) => {
      return { id, level: 0 };
    }),
  };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const internalRecording$ = state(false);
const internalStarting$ = state(false);
const internalTranscribing$ = state(false);
const internalSpeechDetected$ = state(false);
const internalVoiceLevel$ = state(0);
const internalVoiceLevelHistory$ = state(initialVoiceLevelHistory());
const internalVoiceDetectedDuringRecording$ = state(false);
const internalVoiceActivityAvailable$ = state(false);
const internalVoiceActivityCoversRecording$ = state(false);
const internalRecordingStartedAt$ = state<number | null>(null);
const internalRecordingStartedAtEpochMs$ = state<number | null>(null);
const internalStream$ = state<MediaStream | null>(null);
const internalRecorder$ = state<MediaRecorder | null>(null);
const internalRecordingSession$ = state<VoiceRecordingSession | null>(null);
const internalAudioActivityMonitor$ = state<AudioActivityMonitor | null>(null);
const internalStartingPromise$ =
  state<Promise<VoiceRecordingStartup | null> | null>(null);
const internalStopAndTranscribePromise$ = state<Promise<void> | null>(null);
interface VoiceRecordingLifecycle {
  readonly started: () => void;
  readonly finish: () => Promise<void>;
  readonly fail: () => Promise<void>;
}

interface VoiceRecordingOptions {
  readonly autoSegment: boolean;
  readonly autoStopOnSilence: boolean;
}

interface VoiceRecordingCompletion {
  readonly finish: () => Promise<void>;
  readonly fail: () => Promise<void>;
}
const internalRecordingCompletion$ = state<VoiceRecordingCompletion | null>(
  null,
);
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
export const sttVoiceLevel$ = computed((get) => {
  return get(internalVoiceLevel$);
});
export const sttVoiceLevelSamples$ = computed((get) => {
  return get(internalVoiceLevelHistory$).samples;
});
export const sttRecordingStartedAt$ = computed((get) => {
  return get(internalRecordingStartedAtEpochMs$);
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
    const createClient = get(apiClient$);
    const client = createClient(voiceIoQuotaContract);
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
const VOICE_ACTIVITY_HOLD_MS = 500;
const VOICE_ACTIVITY_AUTO_STOP_MS = IN_VITEST ? 50 : 10_000;
const VOICE_ACTIVITY_START_GRACE_MS = 500;
const AUDIO_INPUT_QUOTA_TOAST_ID = "voice-input-quota-limit";

function transcriptionFailedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.transcriptionFailed;
  });
}

function reportMicStartFailure(error: unknown): void {
  L.error("Microphone start failed", error);
  toast.error(microphoneAccessDeniedMessage());
}

function reportAudioActivityMonitorStartFailure(error: unknown): void {
  L.error("Audio activity monitor start failed", error);
}

function microphoneAccessDeniedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.microphoneAccessDenied;
  });
}

function audioInputQuotaLimitMessage(
  tier: BillingTier,
  isAdmin: boolean,
): string {
  if (tier === "team" || tier === "custom") {
    return i18n.t(($) => {
      return $.chat.voice.inputLimitReachedReset;
    });
  }
  if (tier === "pro") {
    return isAdmin
      ? i18n.t(($) => {
          return $.chat.voice.inputLimitReachedPro;
        })
      : i18n.t(($) => {
          return $.chat.voice.inputLimitReachedProMember;
        });
  }
  return isAdmin
    ? i18n.t(($) => {
        return $.chat.voice.inputLimitReached;
      })
    : i18n.t(($) => {
        return $.chat.voice.inputLimitReachedMember;
      });
}

interface VoiceActivity {
  readonly detected: boolean;
  readonly level: number;
}

type VoiceActivityCallback = (activity: VoiceActivity) => void;
type VoiceSegmentTranscribedCallback = (text: string) => void;
type VoiceSilenceStop = ReturnType<typeof createDeferredPromise<void>>;

interface VoiceRecordingSession {
  readonly cancel: () => void;
  readonly handleActivity: (activity: VoiceActivity) => void;
  readonly startSilenceTimeout: () => void;
  readonly stopAndTranscribe: (signal: AbortSignal) => Promise<void>;
}

interface VoiceRecordingStartup {
  readonly stream: MediaStream;
  readonly session: VoiceRecordingSession;
  readonly recordingStartedAt: number;
}

interface AudioActivityTracker {
  handle(samples: Float32Array<ArrayBufferLike>): number;
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
  closePromise: Promise<void> | null;
}

type SttSegmentResult =
  | {
      readonly ok: true;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly quotaExceeded: boolean;
    };

type VoiceSegmentReason = "silence" | "stop";
type CaptureVoiceSegment = (
  reason: VoiceSegmentReason,
  upload: boolean,
) => Promise<RecordedVoiceSegment>;

interface RecordedVoiceSegment {
  readonly blob: Blob | null;
  readonly mimeType: string;
}

interface VoiceSilenceTimer {
  readonly clear: () => void;
  readonly start: () => void;
}

interface VoiceSilenceTimerOptions {
  readonly resetTimerSignal: () => AbortSignal;
  readonly isStopped: () => boolean;
  readonly markStopped: () => void;
  readonly isVoiceActivityReliable: () => boolean;
  readonly onLongSilence: () => void;
}

interface VoiceSegmentTranscriber {
  readonly enqueueSegment: (
    reason: VoiceSegmentReason,
    upload: boolean,
    deliver: boolean,
  ) => Promise<string>;
  readonly enqueueBackgroundSegment: (
    reason: VoiceSegmentReason,
    upload: boolean,
    deliver: boolean,
  ) => void;
  readonly waitForPending: () => Promise<void>;
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
    handle(samples: Float32Array<ArrayBufferLike>): number {
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
      return nextLevel;
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
  await bestEffort(audioContext.close());
}

async function startAudioActivityMonitor(
  stream: MediaStream,
  onActivity: VoiceActivityCallback,
  onLevelSample: (level: number) => void,
  signal: AbortSignal,
): Promise<AudioActivityMonitor | null> {
  const AudioContextConstructor = audioContextConstructor();
  if (!AudioContextConstructor) {
    return null;
  }

  const audioContext = new AudioContextConstructor();
  let audioContextClosePromise: Promise<void> | null = null;
  let monitor: AudioActivityMonitor | null = null;
  let retainedByMonitor = false;
  const stopOnAbort = () => {
    if (monitor) {
      stopAudioActivityMonitor(monitor);
      return;
    }
    audioContextClosePromise ??= closeAudioContextQuietly(audioContext);
  };
  signal.addEventListener("abort", stopOnAbort, { once: true });
  return await withCleanup(
    (async () => {
      signal.throwIfAborted();
      if (
        typeof audioContext.createMediaStreamSource !== "function" ||
        typeof audioContext.createAnalyser !== "function"
      ) {
        return null;
      }

      await audioContext.resume();
      signal.throwIfAborted();

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      const requestFrame = window.requestAnimationFrame.bind(window);
      analyser.fftSize = 1024;
      source.connect(analyser);

      const startedMonitor: AudioActivityMonitor = {
        audioContext,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        tracker: createAudioActivityTracker(onActivity),
        cancelFrame: window.cancelAnimationFrame.bind(window),
        frameId: null,
        stopped: false,
        closePromise: null,
      };
      monitor = startedMonitor;

      let nextLevelSampleAt =
        audioActivityNow() + VOICE_LEVEL_SAMPLE_INTERVAL_MS;
      const update = () => {
        if (startedMonitor.stopped) {
          return;
        }
        startedMonitor.analyser.getFloatTimeDomainData(startedMonitor.samples);
        const level = startedMonitor.tracker.handle(startedMonitor.samples);
        const currentTime = audioActivityNow();
        if (currentTime >= nextLevelSampleAt) {
          onLevelSample(level);
          nextLevelSampleAt = currentTime + VOICE_LEVEL_SAMPLE_INTERVAL_MS;
        }
        startedMonitor.frameId = requestFrame(update);
      };

      update();
      retainedByMonitor = true;
      return startedMonitor;
    })(),
    async () => {
      if (retainedByMonitor) {
        return;
      }
      signal.removeEventListener("abort", stopOnAbort);
      if (monitor) {
        await stopAudioActivityMonitorAndWait(monitor);
        return;
      }
      audioContextClosePromise ??= closeAudioContextQuietly(audioContext);
      await audioContextClosePromise;
    },
  );
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
  monitor.closePromise = closeAudioContextQuietly(monitor.audioContext);
}

async function stopAudioActivityMonitorAndWait(
  monitor: AudioActivityMonitor,
): Promise<void> {
  stopAudioActivityMonitor(monitor);
  if (monitor.closePromise) {
    await monitor.closePromise;
  }
}

function isAudioInputQuotaExceeded(failure: SttApiFailure): boolean {
  return (
    failure.status === 402 && failure.code === "AUDIO_INPUT_QUOTA_EXCEEDED"
  );
}

function isAudioInputQuotaFailure(failure: SttApiFailure): boolean {
  return (
    isAudioInputQuotaExceeded(failure) ||
    (failure.status === 429 &&
      (failure.code === "DAILY_RATE_LIMIT_EXCEEDED" ||
        failure.code === "DAILY_DURATION_LIMIT_EXCEEDED"))
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
  toast.error(transcriptionFailedMessage());
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
  set(internalVoiceLevelHistory$, initialVoiceLevelHistory());
  set(internalVoiceDetectedDuringRecording$, false);
  set(internalVoiceActivityAvailable$, false);
  set(internalVoiceActivityCoversRecording$, false);
  set(internalRecordingStartedAt$, null);
  set(internalRecordingStartedAtEpochMs$, null);
  set(internalRecorder$, null);
  set(internalRecordingSession$, null);
  set(internalAudioActivityMonitor$, null);
  set(internalStartingPromise$, null);
  set(internalStopAndTranscribePromise$, null);
  set(internalRecordingCompletion$, null);
  set(internalStream$, null);
});

const appendVoiceLevelSample$ = command(({ set }, level: number) => {
  set(internalVoiceLevelHistory$, (history) => {
    return {
      nextId: history.nextId + 1,
      samples: [...history.samples.slice(1), { id: history.nextId, level }],
    };
  });
});

const prepareRecordingStart$ = command(({ set }) => {
  set(internalStarting$, true);
  set(internalSpeechDetected$, false);
  set(internalVoiceLevel$, 0);
  set(internalVoiceLevelHistory$, initialVoiceLevelHistory());
  set(internalVoiceDetectedDuringRecording$, false);
  set(internalVoiceActivityAvailable$, false);
  set(internalVoiceActivityCoversRecording$, false);
  set(internalRecordingSession$, null);
});

const startMediaRecorder$ = command(
  ({ set }, recorder: MediaRecorder): number => {
    recorder.start();
    const recordingStartedAt = audioActivityNow();
    set(internalRecordingStartedAt$, recordingStartedAt);
    set(internalRecordingStartedAtEpochMs$, currentTimeMs());
    set(internalRecording$, true);
    return recordingStartedAt;
  },
);

const prepareRecordingLifecycle$ = command(
  (
    { set },
    parentSignal: AbortSignal,
    lifecycle: VoiceRecordingLifecycle | undefined,
  ): AbortSignal => {
    const signal = set(resetRecord$, parentSignal);
    if (lifecycle) {
      let settled = false;
      const settleOnce = async (
        callback: () => Promise<void>,
      ): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        await callback();
      };
      set(internalRecordingCompletion$, {
        finish: async () => {
          await settleOnce(lifecycle.finish);
        },
        fail: async () => {
          await settleOnce(lifecycle.fail);
        },
      });
    } else {
      set(internalRecordingCompletion$, null);
    }
    signal.addEventListener(
      "abort",
      () => {
        set(resetState$);
      },
      { once: true },
    );
    set(prepareRecordingStart$);
    return signal;
  },
);

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

const refreshAudioInputQuota$ = command(({ set }) => {
  set(audioInputQuotaReload$, (x) => {
    return x + 1;
  });
});

export const openAudioInputQuotaRecovery$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const isAdmin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    const billingStatus = await get(billingStatusAsync$);
    signal.throwIfAborted();
    const tier = apiTierToBillingTier(billingStatus.tier);
    const waitsForReset = tier === "team" || tier === "custom";
    toast.error(audioInputQuotaLimitMessage(tier, isAdmin), {
      id: AUDIO_INPUT_QUOTA_TOAST_ID,
    });
    set(refreshAudioInputQuota$);
    if (!isAdmin || waitsForReset) {
      return;
    }
    set(setBillingSubPage$, true);
    await set(openSettingsDialogAt$, "billing", get(pageSignal$));
  },
);

interface SttApiFailure {
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
}

type SttApiResult =
  | { readonly ok: true; readonly text: string }
  | ({ readonly ok: false } & SttApiFailure);

interface TranscribeAudioBlobInput {
  readonly blob: Blob;
  readonly mimeType: string;
  readonly captureReason: VoiceSegmentReason;
}

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
    const body = jsonParseOr<{
      error?: { code?: string; message?: string };
    } | null>(await response.text(), null);
    signal.throwIfAborted();
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
  // getUserMedia rejects on permission denied and does not accept a signal, so
  // settle() supplies the cancellation check the raw rejection cannot.
  const opened = await settle(
    navigator.mediaDevices.getUserMedia({ audio: audioConfig.constraints }),
    signal,
  );
  if (!opened.ok) {
    L.error("Microphone access denied", opened.error);
    toast.error(microphoneAccessDeniedMessage());
    return;
  }
  return opened.value;
}

async function captureRecorderData(
  recorder: MediaRecorder,
  signal: AbortSignal,
  action: () => void,
): Promise<Blob | null> {
  if (recorder.state === "inactive") {
    return null;
  }

  const deferred = createDeferredPromise<Blob | null>(signal);
  const handleData = (event: Event) => {
    const dataEvent = event as BlobEvent;
    deferred.resolve(dataEvent.data.size > 0 ? dataEvent.data : null);
  };

  recorder.addEventListener("dataavailable", handleData, {
    once: true,
    signal,
  });
  action();
  return await deferred.promise;
}

async function stopRecorderAndCaptureData(
  recorder: MediaRecorder,
  signal: AbortSignal,
): Promise<Blob | null> {
  if (recorder.state === "inactive") {
    return null;
  }

  const stopDeferred = createDeferredPromise<void>(signal);
  recorder.addEventListener(
    "stop",
    () => {
      stopDeferred.resolve();
    },
    { once: true, signal },
  );

  const blob = await captureRecorderData(recorder, signal, () => {
    recorder.stop();
  });
  await stopDeferred.promise;
  return blob;
}

const transcribeAudioBlob$ = command(
  async (
    { get, set },
    input: TranscribeAudioBlobInput,
    signal: AbortSignal,
  ): Promise<SttSegmentResult> => {
    const { blob, mimeType, captureReason } = input;
    const fetchFn = get(fetch$);
    const formData = new FormData();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const recordingStartedAt = get(internalRecordingStartedAt$);
    const sessionElapsedMs =
      recordingStartedAt === null
        ? null
        : Math.max(0, Math.round(audioActivityNow() - recordingStartedAt));
    const clientDiagnostics = {
      captureReason,
      sessionElapsedMs,
      sessionVoiceDetected: get(internalVoiceDetectedDuringRecording$),
      voiceActivityAvailable: get(internalVoiceActivityAvailable$),
      voiceActivityCoversRecording: get(internalVoiceActivityCoversRecording$),
    };

    formData.append("file", blob, `recording.${extension}`);
    formData.append("clientDiagnostics", JSON.stringify(clientDiagnostics));

    L.debug("Uploading voice input audio", {
      blobSize: blob.size,
      mimeType,
      ...clientDiagnostics,
    });

    const response = await tapError(
      fetchFn("/api/voice-io/stt", {
        method: "POST",
        body: formData,
        signal,
      }),
      (error) => {
        L.error("STT fetch failed", error);
        toast.error(transcriptionFailedMessage());
      },
    );
    signal.throwIfAborted();
    if (!response) {
      return { ok: false, quotaExceeded: false };
    }

    const result = await readSttApiResponse(response, signal);
    if (!result.ok) {
      if (isAudioInputQuotaFailure(result)) {
        await set(openAudioInputQuotaRecovery$, signal);
        return { ok: false, quotaExceeded: true };
      }

      logSttFailure(result, {
        recordedMime: mimeType,
        recordedSize: blob.size,
      });
      return { ok: false, quotaExceeded: false };
    }

    set(refreshAudioInputQuota$);
    return { ok: true, text: result.text };
  },
);

interface VoiceSegmentSessionOptions {
  readonly initialRecorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly autoSegment: boolean;
  readonly autoStopOnSilence: boolean;
  readonly onSegmentTranscribed: VoiceSegmentTranscribedCallback;
  readonly transcribeBlob: (
    input: TranscribeAudioBlobInput,
    signal: AbortSignal,
  ) => Promise<SttSegmentResult>;
  readonly isVoiceActivityReliable: () => boolean;
  readonly resetSilenceTimerSignal: () => AbortSignal;
  readonly onLongSilence: () => void;
  readonly onQuotaExceeded: () => Promise<void>;
  readonly onRecorderChanged: (recorder: MediaRecorder) => void;
}

async function uploadCapturedBlob(
  options: VoiceSegmentSessionOptions,
  segment: RecordedVoiceSegment,
  captureReason: VoiceSegmentReason,
  upload: boolean,
  signal: AbortSignal,
): Promise<string> {
  if (!segment.blob || !upload) {
    return "";
  }

  const result = await options.transcribeBlob(
    { blob: segment.blob, mimeType: segment.mimeType, captureReason },
    signal,
  );
  if (!result.ok) {
    if (result.quotaExceeded) {
      await options.onQuotaExceeded();
    }
    return "";
  }
  return result.text;
}

function createVoiceSegmentCapture(
  options: VoiceSegmentSessionOptions & {
    readonly activeRecorder: () => MediaRecorder;
    readonly startNextRecorder: () => void;
  },
  signal: AbortSignal,
): CaptureVoiceSegment {
  let captureQueue: Promise<void> = Promise.resolve();

  return async (reason, upload): Promise<RecordedVoiceSegment> => {
    const previousCapture = captureQueue;
    const nextCapture = createDeferredPromise<void>(signal);
    captureQueue = nextCapture.promise;

    await previousCapture;
    let blob: Blob | null = null;
    let mimeType = "";
    await withCleanup(
      (async () => {
        const recorder = options.activeRecorder();
        mimeType = recorder.mimeType;
        if (reason === "stop") {
          blob = await stopRecorderAndCaptureData(recorder, signal);
        } else if (upload && recorder.state !== "inactive") {
          blob = await stopRecorderAndCaptureData(recorder, signal);
          signal.throwIfAborted();
          options.startNextRecorder();
        }
        signal.throwIfAborted();
      })(),
      () => {
        nextCapture.resolve(undefined);
      },
    );

    return { blob, mimeType };
  };
}

function createVoiceSegmentTranscriber(
  options: VoiceSegmentSessionOptions,
  captureSegment: CaptureVoiceSegment,
  clearCurrentSegmentVoice: () => void,
  signal: AbortSignal,
): VoiceSegmentTranscriber {
  const pendingTranscriptions: Promise<string>[] = [];
  let uploadQueue: Promise<void> = Promise.resolve();

  const uploadSegment = async (
    segment: RecordedVoiceSegment,
    reason: VoiceSegmentReason,
    upload: boolean,
  ): Promise<string> => {
    const previousUpload = uploadQueue;
    const nextUpload = createDeferredPromise<void>(signal);
    uploadQueue = nextUpload.promise;

    await previousUpload;
    return await withCleanup(
      uploadCapturedBlob(options, segment, reason, upload, signal),
      () => {
        if (!nextUpload.settled()) {
          nextUpload.resolve(undefined);
        }
      },
    );
  };

  const captureAndUploadSegment = async (
    reason: VoiceSegmentReason,
    upload: boolean,
  ): Promise<string> => {
    const segment = await captureSegment(reason, upload);
    return await uploadSegment(segment, reason, upload);
  };

  const enqueueSegment = (
    reason: VoiceSegmentReason,
    upload: boolean,
    deliver: boolean,
  ): Promise<string> => {
    clearCurrentSegmentVoice();
    const transcription = (async () => {
      const text =
        (await tapError(captureAndUploadSegment(reason, upload), (error) => {
          L.error("Voice segment transcription failed", error);
          toast.error(transcriptionFailedMessage());
        })) ?? "";
      if (deliver && text) {
        options.onSegmentTranscribed(text);
      }
      return text;
    })();
    pendingTranscriptions.push(transcription);
    return transcription;
  };

  const enqueueBackgroundSegment = (
    reason: VoiceSegmentReason,
    upload: boolean,
    deliver: boolean,
  ): void => {
    clearCurrentSegmentVoice();
    const transcription = (async () => {
      const [result] = await Promise.allSettled([
        captureAndUploadSegment(reason, upload),
      ]);
      if (result.status === "rejected") {
        if (!signal.aborted) {
          L.error("Voice segment transcription failed", result.reason);
          toast.error(transcriptionFailedMessage());
        }
        return "";
      }
      if (deliver && result.value) {
        options.onSegmentTranscribed(result.value);
      }
      return result.value;
    })();
    pendingTranscriptions.push(transcription);
  };

  const waitForPending = async (): Promise<void> => {
    await Promise.all(pendingTranscriptions);
  };

  return { enqueueSegment, enqueueBackgroundSegment, waitForPending };
}

function createVoiceSilenceTimer(
  options: VoiceSilenceTimerOptions,
): VoiceSilenceTimer {
  let timerSignal: AbortSignal | null = null;

  const clear = (): void => {
    if (timerSignal) {
      options.resetTimerSignal();
      timerSignal = null;
    }
  };

  const start = (): void => {
    clear();
    if (options.isStopped() || !options.isVoiceActivityReliable()) {
      return;
    }
    const signal = options.resetTimerSignal();
    timerSignal = signal;
    timeout(
      () => {
        if (timerSignal !== signal) {
          return;
        }
        timerSignal = null;
        if (options.isStopped() || !options.isVoiceActivityReliable()) {
          return;
        }
        options.markStopped();
        options.onLongSilence();
      },
      VOICE_ACTIVITY_AUTO_STOP_MS,
      { signal },
    );
  };

  return { clear, start };
}

function createVoiceSegmentSession(
  options: VoiceSegmentSessionOptions,
  signal: AbortSignal,
): VoiceRecordingSession {
  let currentSegmentHasVoice = false;
  let stopped = false;
  let activeRecorder = options.initialRecorder;
  const captureSegment = createVoiceSegmentCapture(
    {
      ...options,
      activeRecorder: () => {
        return activeRecorder;
      },
      startNextRecorder: () => {
        const recorder = createMediaRecorder(options.stream);
        recorder.start();
        activeRecorder = recorder;
        options.onRecorderChanged(recorder);
      },
    },
    signal,
  );
  const transcriber = createVoiceSegmentTranscriber(
    options,
    captureSegment,
    () => {
      currentSegmentHasVoice = false;
    },
    signal,
  );

  const shouldUploadStopSegment = () => {
    return currentSegmentHasVoice || !options.isVoiceActivityReliable();
  };

  const silenceTimer = createVoiceSilenceTimer({
    resetTimerSignal: options.resetSilenceTimerSignal,
    isStopped: () => {
      return stopped;
    },
    markStopped: () => {
      stopped = true;
    },
    isVoiceActivityReliable: options.isVoiceActivityReliable,
    onLongSilence: options.onLongSilence,
  });

  return {
    cancel(): void {
      stopped = true;
      silenceTimer.clear();
      if (activeRecorder.state !== "inactive") {
        activeRecorder.stop();
      }
    },
    handleActivity(activity: VoiceActivity): void {
      if (activity.detected || activity.level > 0) {
        silenceTimer.clear();
      }
      if (activity.level > 0) {
        currentSegmentHasVoice = true;
      }
      if (!activity.detected && !stopped) {
        if (options.autoSegment && currentSegmentHasVoice) {
          transcriber.enqueueBackgroundSegment("silence", true, true);
        }
        if (options.autoStopOnSilence) {
          silenceTimer.start();
        }
      }
    },
    startSilenceTimeout(): void {
      if (options.autoStopOnSilence && !currentSegmentHasVoice) {
        silenceTimer.start();
      }
    },
    async stopAndTranscribe(stopSignal: AbortSignal): Promise<void> {
      stopped = true;
      silenceTimer.clear();
      await transcriber.enqueueSegment("stop", shouldUploadStopSegment(), true);
      stopSignal.throwIfAborted();
      await transcriber.waitForPending();
    },
  };
}

export const startRecording$ = command(
  async (
    { get, set },
    onSegmentTranscribed: VoiceSegmentTranscribedCallback,
    options: VoiceRecordingOptions,
    lifecycle: VoiceRecordingLifecycle | undefined,
    parentSignal: AbortSignal,
  ) => {
    if (
      get(internalStarting$) ||
      get(internalRecording$) ||
      get(internalTranscribing$)
    ) {
      return;
    }

    const { autoSegment, autoStopOnSilence } = options;
    const signal = set(prepareRecordingLifecycle$, parentSignal, lifecycle);
    let audioActivityMonitor: AudioActivityMonitor | null = null;
    let voiceActivityReliable = false;
    let silenceStop: VoiceSilenceStop | null = null;
    const starting = withCleanup(
      (async (): Promise<VoiceRecordingStartup | null> => {
        await waitForBrowserPaint(signal);
        signal.throwIfAborted();

        const stream = await tapError(openMedia(signal), reportMicStartFailure);
        if (!stream) {
          return null;
        }

        const recorder = createMediaRecorder(stream);
        const sessionOptions: VoiceSegmentSessionOptions = {
          initialRecorder: recorder,
          stream,
          autoSegment,
          autoStopOnSilence,
          onSegmentTranscribed,
          transcribeBlob: (input, uploadSignal) => {
            return set(transcribeAudioBlob$, input, uploadSignal);
          },
          isVoiceActivityReliable: () => {
            return voiceActivityReliable;
          },
          resetSilenceTimerSignal: () => {
            return set(resetVoiceSilenceTimer$, signal);
          },
          onLongSilence: () => {
            if (silenceStop && !silenceStop.settled()) {
              silenceStop.resolve(undefined);
            }
          },
          onQuotaExceeded: async () => {
            const recordingCompletion = get(internalRecordingCompletion$);
            set(resetRecord$);
            await recordingCompletion?.fail();
          },
          onRecorderChanged: (nextRecorder) => {
            set(internalRecorder$, nextRecorder);
          },
        };
        const session = createVoiceSegmentSession(sessionOptions, signal);

        signal.addEventListener("abort", () => {
          session.cancel();
          stopAllTracks(stream);
          set(resetState$);
        });

        const recordingStartedAt = set(startMediaRecorder$, recorder);
        set(internalStream$, stream);
        set(internalRecorder$, recorder);
        set(internalRecordingSession$, session);
        lifecycle?.started();
        return { stream, session, recordingStartedAt };
      })(),
      () => {
        if (get(internalStartingPromise$) === starting) {
          set(internalStartingPromise$, null);
          set(internalStarting$, false);
        }
      },
    );
    set(internalStartingPromise$, starting);
    const startup = await starting;
    if (!startup) {
      const recordingCompletion = get(internalRecordingCompletion$);
      set(resetRecord$);
      await recordingCompletion?.finish();
      return;
    }
    const { stream, session: recordingSession, recordingStartedAt } = startup;
    const startedAudioActivityMonitor = await tapError(
      startAudioActivityMonitor(
        stream,
        (activity) => {
          set(internalSpeechDetected$, activity.detected);
          set(internalVoiceLevel$, activity.level);
          if (activity.level > 0) {
            set(internalVoiceDetectedDuringRecording$, true);
          }
          recordingSession.handleActivity(activity);
        },
        (level) => {
          set(appendVoiceLevelSample$, level);
        },
        signal,
      ),
      reportAudioActivityMonitorStartFailure,
    );
    signal.throwIfAborted();
    if (startedAudioActivityMonitor === undefined) {
      set(internalVoiceActivityAvailable$, false);
      return;
    }
    audioActivityMonitor = startedAudioActivityMonitor;
    const monitorStartedAt = audioActivityNow();
    voiceActivityReliable =
      audioActivityMonitor !== null &&
      monitorStartedAt - recordingStartedAt <= VOICE_ACTIVITY_START_GRACE_MS;
    set(internalAudioActivityMonitor$, audioActivityMonitor);
    set(internalVoiceActivityAvailable$, audioActivityMonitor !== null);
    set(internalVoiceActivityCoversRecording$, voiceActivityReliable);
    if (voiceActivityReliable && autoStopOnSilence) {
      silenceStop = createDeferredPromise<void>(signal);
      recordingSession.startSilenceTimeout();
      await silenceStop.promise;
      signal.throwIfAborted();
      await set(stopAndTranscribe$, signal);
    }
  },
);

export const stopAndTranscribe$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const activeCompletion = get(internalStopAndTranscribePromise$);
    if (activeCompletion) {
      await activeCompletion;
      signal.throwIfAborted();
      return;
    }
    const starting = get(internalStartingPromise$);
    if (starting) {
      await starting;
      signal.throwIfAborted();
      await set(stopAndTranscribe$, signal);
      return;
    }
    if (!get(internalRecording$)) {
      return;
    }

    const recordingCompletion = get(internalRecordingCompletion$);
    const completion = withCleanup(
      withCleanup(
        (async () => {
          const recorder = get(internalRecorder$);
          const session = get(internalRecordingSession$);
          const audioActivityMonitor = get(internalAudioActivityMonitor$);
          if (audioActivityMonitor) {
            await stopAudioActivityMonitorAndWait(audioActivityMonitor);
            signal.throwIfAborted();
            set(internalAudioActivityMonitor$, null);
            set(internalSpeechDetected$, false);
            set(internalVoiceLevel$, 0);
          }

          if (!session) {
            if (recorder && recorder.state !== "inactive") {
              recorder.stop();
            }
            return;
          }

          set(internalRecording$, false);
          set(internalTranscribing$, true);
          await session.stopAndTranscribe(signal);
        })(),
        () => {
          set(resetRecord$);
        },
      ),
      async () => {
        if (recordingCompletion) {
          await recordingCompletion.finish();
        }
      },
    );
    set(internalStopAndTranscribePromise$, completion);
    await completion;
  },
);
