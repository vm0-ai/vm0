import { command, computed, state } from "ccstate";
import {
  zeroVoiceIoQuotaContract,
  type AudioInputQuotaResponse,
} from "@vm0/api-contracts/contracts/zero-voice-io-quota";
import { fetch$ } from "../fetch.ts";
import { pageSignal$ } from "../page-signal.ts";
import { zeroClient$ } from "../api-client.ts";
import { setBillingSubPage$ } from "../zero-page/settings/workspace-settings-state.ts";
import { openSettingsDialogAt$ } from "../zero-page/settings/settings-dialog.ts";
import { logger } from "../log.ts";
import {
  bestEffort,
  createDeferredPromise,
  jsonParseOr,
  resetSignal,
  tapError,
  withCleanup,
} from "../utils.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { accept } from "../../lib/accept.ts";
import { IN_VITEST } from "../../env.ts";
import { now as currentTimeMs } from "../../lib/time.ts";
import { resolveAudioConfig } from "../../lib/voice-io/audio-config.ts";
import { i18n } from "../../i18n/index.ts";

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
const internalRecorder$ = state<MediaRecorder | null>(null);
const internalRecordingSession$ = state<VoiceRecordingSession | null>(null);
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
const VOICE_ACTIVITY_HOLD_MS = 500;
const VOICE_ACTIVITY_AUTO_STOP_MS = IN_VITEST ? 50 : 10_000;
const VOICE_ACTIVITY_START_GRACE_MS = 500;
const AUDIO_INPUT_QUOTA_TOAST_ID = "voice-input-quota-limit";

function transcriptionFailedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.transcriptionFailed;
  });
}

function microphoneAccessDeniedMessage(): string {
  return i18n.t(($) => {
    return $.chat.voice.microphoneAccessDenied;
  });
}

interface VoiceActivity {
  readonly detected: boolean;
  readonly level: number;
}

type VoiceActivityCallback = (activity: VoiceActivity) => void;
type VoiceSegmentTranscribedCallback = (text: string) => void;

interface VoiceRecordingSession {
  readonly cancel: () => void;
  readonly handleActivity: (activity: VoiceActivity) => void;
  readonly startSilenceTimeout: () => void;
  readonly stopAndTranscribe: (signal: AbortSignal) => Promise<string>;
}

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
  await bestEffort(audioContext.close());
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

  update();
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
  set(internalVoiceDetectedDuringRecording$, false);
  set(internalVoiceActivityAvailable$, false);
  set(internalVoiceActivityCoversRecording$, false);
  set(internalRecorder$, null);
  set(internalRecordingSession$, null);
  set(internalAudioActivityMonitor$, null);
  set(internalStream$, null);
});

const prepareRecordingStart$ = command(({ set }) => {
  set(internalStarting$, true);
  set(internalSpeechDetected$, false);
  set(internalVoiceLevel$, 0);
  set(internalVoiceDetectedDuringRecording$, false);
  set(internalVoiceActivityAvailable$, false);
  set(internalVoiceActivityCoversRecording$, false);
  set(internalRecordingSession$, null);
});

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
    toast.error(
      i18n.t(($) => {
        return $.chat.voice.inputLimitReached;
      }),
      {
        id: AUDIO_INPUT_QUOTA_TOAST_ID,
      },
    );
    set(refreshAudioInputQuota$);
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
    toast.error(microphoneAccessDeniedMessage());
    return;
  }
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
    blob: Blob,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<SttSegmentResult> => {
    const fetchFn = get(fetch$);
    const formData = new FormData();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    formData.append("file", blob, `recording.${extension}`);

    const response = await tapError(
      fetchFn("/api/zero/voice-io/stt", {
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
  readonly signal: AbortSignal;
  readonly autoSegment: boolean;
  readonly onSegmentTranscribed: VoiceSegmentTranscribedCallback;
  readonly transcribeBlob: (
    blob: Blob,
    mimeType: string,
    signal: AbortSignal,
  ) => Promise<SttSegmentResult>;
  readonly isVoiceActivityReliable: () => boolean;
  readonly onLongSilence: () => void;
  readonly onQuotaExceeded: () => void;
  readonly onRecorderChanged: (recorder: MediaRecorder) => void;
}

async function uploadCapturedBlob(
  options: VoiceSegmentSessionOptions,
  blob: Blob | null,
  mimeType: string,
  upload: boolean,
): Promise<string> {
  if (!blob || !upload) {
    return "";
  }

  const result = await options.transcribeBlob(blob, mimeType, options.signal);
  if (!result.ok) {
    if (result.quotaExceeded) {
      options.onQuotaExceeded();
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
): CaptureVoiceSegment {
  let captureQueue: Promise<void> = Promise.resolve();

  return async (reason, upload): Promise<RecordedVoiceSegment> => {
    const previousCapture = captureQueue;
    const nextCapture = createDeferredPromise<void>(options.signal);
    captureQueue = nextCapture.promise;

    await previousCapture;
    let blob: Blob | null = null;
    let mimeType = "";
    await withCleanup(
      (async () => {
        const recorder = options.activeRecorder();
        mimeType = recorder.mimeType;
        if (reason === "stop") {
          blob = await stopRecorderAndCaptureData(recorder, options.signal);
        } else if (upload && recorder.state !== "inactive") {
          blob = await stopRecorderAndCaptureData(recorder, options.signal);
          options.signal.throwIfAborted();
          options.startNextRecorder();
        }
        options.signal.throwIfAborted();
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
): VoiceSegmentTranscriber {
  const pendingTranscriptions: Promise<string>[] = [];
  const captureAndUploadSegment = async (
    reason: VoiceSegmentReason,
    upload: boolean,
  ): Promise<string> => {
    const segment = await captureSegment(reason, upload);
    return await uploadCapturedBlob(
      options,
      segment.blob,
      segment.mimeType,
      upload,
    );
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
        if (!options.signal.aborted) {
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
  let timerId: number | null = null;

  const clear = (): void => {
    if (timerId !== null) {
      window.clearTimeout(timerId);
      timerId = null;
    }
  };

  const start = (): void => {
    clear();
    if (options.isStopped() || !options.isVoiceActivityReliable()) {
      return;
    }
    timerId = window.setTimeout(() => {
      timerId = null;
      if (options.isStopped() || !options.isVoiceActivityReliable()) {
        return;
      }
      options.markStopped();
      options.onLongSilence();
    }, VOICE_ACTIVITY_AUTO_STOP_MS);
  };

  return { clear, start };
}

function createVoiceSegmentSession(
  options: VoiceSegmentSessionOptions,
): VoiceRecordingSession {
  let currentSegmentHasVoice = false;
  let stopped = false;
  let activeRecorder = options.initialRecorder;
  const captureSegment = createVoiceSegmentCapture({
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
  });
  const transcriber = createVoiceSegmentTranscriber(
    options,
    captureSegment,
    () => {
      currentSegmentHasVoice = false;
    },
  );

  const shouldUploadStopSegment = () => {
    return currentSegmentHasVoice || !options.isVoiceActivityReliable();
  };

  const silenceTimer = createVoiceSilenceTimer({
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
        silenceTimer.start();
      }
    },
    startSilenceTimeout(): void {
      silenceTimer.start();
    },
    async stopAndTranscribe(stopSignal: AbortSignal): Promise<string> {
      stopped = true;
      silenceTimer.clear();
      const finalText = await transcriber.enqueueSegment(
        "stop",
        shouldUploadStopSegment(),
        false,
      );
      stopSignal.throwIfAborted();
      await transcriber.waitForPending();
      return finalText;
    },
  };
}

export const startRecording$ = command(
  async (
    { get, set },
    onSegmentTranscribed: VoiceSegmentTranscribedCallback,
    autoSegment: boolean,
    parentSignal: AbortSignal,
  ) => {
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
    set(prepareRecordingStart$);

    await waitForBrowserPaint(signal);
    signal.throwIfAborted();

    const stream = await tapError(openMedia(signal), (error) => {
      L.error("Microphone start failed", error);
      toast.error(microphoneAccessDeniedMessage());
    });
    if (stream === undefined) {
      set(internalStarting$, false);
      return;
    }
    if (!stream) {
      set(internalStarting$, false);
      return;
    }

    const recorder = createMediaRecorder(stream);
    let audioActivityMonitor: AudioActivityMonitor | null = null;
    let voiceActivityReliable = false;
    let longSilenceStop: ReturnType<typeof createDeferredPromise<void>> | null =
      null;
    const recordingSession = createVoiceSegmentSession({
      initialRecorder: recorder,
      stream,
      signal,
      autoSegment,
      onSegmentTranscribed,
      transcribeBlob: async (blob, mimeType, uploadSignal) => {
        return await set(transcribeAudioBlob$, blob, mimeType, uploadSignal);
      },
      isVoiceActivityReliable: () => {
        return voiceActivityReliable;
      },
      onLongSilence: () => {
        if (longSilenceStop && !longSilenceStop.settled()) {
          longSilenceStop.resolve(undefined);
        }
      },
      onQuotaExceeded: () => {
        set(resetRecord$);
      },
      onRecorderChanged: (nextRecorder) => {
        set(internalRecorder$, nextRecorder);
      },
    });

    signal.addEventListener("abort", () => {
      recordingSession.cancel();
      if (audioActivityMonitor) {
        stopAudioActivityMonitor(audioActivityMonitor);
      }
      stopAllTracks(stream);
      set(resetState$);
    });

    set(internalStarting$, false);
    recorder.start();
    const recordingStartedAt = audioActivityNow();
    set(internalRecording$, true);
    set(internalStream$, stream);
    set(internalRecorder$, recorder);
    set(internalRecordingSession$, recordingSession);
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
        signal,
      ),
      (error) => {
        L.error("Audio activity monitor start failed", error);
      },
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
    if (voiceActivityReliable) {
      longSilenceStop = createDeferredPromise<void>(signal);
      recordingSession.startSilenceTimeout();
    } else {
      return;
    }

    await longSilenceStop.promise;
    signal.throwIfAborted();
    const text = await set(stopAndTranscribe$, signal);
    if (text) {
      onSegmentTranscribed(text);
    }
  },
);

export const stopAndTranscribe$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<string> => {
    if (!get(internalRecording$)) {
      return "";
    }

    const recorder = get(internalRecorder$);
    const session = get(internalRecordingSession$);
    const audioActivityMonitor = get(internalAudioActivityMonitor$);
    if (audioActivityMonitor) {
      stopAudioActivityMonitor(audioActivityMonitor);
      await closeAudioContextQuietly(audioActivityMonitor.audioContext);
      signal.throwIfAborted();
      set(internalAudioActivityMonitor$, null);
      set(internalSpeechDetected$, false);
      set(internalVoiceLevel$, 0);
    }

    if (!session) {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      set(resetRecord$);
      return "";
    }

    set(internalRecording$, false);
    set(internalTranscribing$, true);
    return await withCleanup(session.stopAndTranscribe(signal), () => {
      set(resetRecord$);
    });
  },
);
