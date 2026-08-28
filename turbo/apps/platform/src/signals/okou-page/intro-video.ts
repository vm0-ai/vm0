import type {
  AvatarVideoAvatar,
  AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import {
  command,
  computed,
  state,
  type Command,
  type Getter,
  type Setter,
  type State,
} from "ccstate";
import { delay } from "signal-timers";

import { i18n } from "../../i18n/index.ts";
import { now } from "../../lib/time.ts";
import {
  deleteIntroVideoDraft,
  readIntroVideoDraft,
  saveIntroVideoDraft,
  type IntroVideoDraftRecord,
  type IntroVideoSourceKind,
} from "../external/intro-video-draft-store.ts";
import type { ComposerSignals } from "./composer-signals.ts";
import { createDeferredPromise, onRef, settle } from "../utils.ts";

export type IntroVideoWizardStep =
  | "avatar"
  | "countdown"
  | "record-setup"
  | "recording"
  | "review"
  | "source"
  | "source-review"
  | "voice";

export type IntroVideoWizardError =
  | "recording-empty"
  | "recording-failed"
  | "recording-permission"
  | "recording-share-ended"
  | "recording-unsupported"
  | "send-failed"
  | "upload-failed";

export interface IntroVideoSource {
  readonly blob: Blob;
  readonly contentType: string;
  readonly durationSeconds: number | null;
  readonly kind: IntroVideoSourceKind;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly size: number;
}

export type IntroVideoVoiceSelection =
  | { readonly kind: "catalog"; readonly voice: AvatarVideoVoice }
  | { readonly kind: "none" }
  | { readonly kind: "original" };

interface RecordingRuntime {
  audioContext: AudioContext | null;
  audioContextClose: Promise<void> | null;
  chunks: Blob[];
  displayStream: MediaStream | null;
  generation: number;
  microphoneStream: MediaStream | null;
  recorder: MediaRecorder | null;
  recordingStartedAt: number;
  recordingStream: MediaStream | null;
  stopCompletion: Promise<void> | null;
  stopCompletionResolve: (() => void) | null;
  stopCompletionSettled: (() => boolean) | null;
  stopAction: Promise<void> | null;
  timer: number | null;
}

const DOCUMENT_EXTENSIONS = ["doc", "docx", "pdf", "ppt", "pptx"] as const;
const VIDEO_EXTENSIONS = ["mov", "mp4", "webm"] as const;
const DEFAULT_INSTRUCTIONS =
  "Create a concise 30 second product intro. Zoom in on important actions, remove pauses, and keep the pacing energetic.";
const RECORDING_FILE_NAME = "Screen recording.webm";

function createRecordingRuntime(): RecordingRuntime {
  return {
    audioContext: null,
    audioContextClose: null,
    chunks: [],
    displayStream: null,
    generation: 0,
    microphoneStream: null,
    recorder: null,
    recordingStartedAt: 0,
    recordingStream: null,
    stopCompletion: null,
    stopCompletionResolve: null,
    stopCompletionSettled: null,
    stopAction: null,
    timer: null,
  };
}

function extensionForFilename(filename: string): string {
  return filename.split(".").pop()?.toLocaleLowerCase() ?? "";
}

export function classifyIntroVideoSource(
  file: Pick<File, "name" | "type">,
): IntroVideoSourceKind | null {
  const extension = extensionForFilename(file.name);
  if (
    DOCUMENT_EXTENSIONS.some((candidate) => {
      return candidate === extension;
    })
  ) {
    return "document";
  }
  if (
    VIDEO_EXTENSIONS.some((candidate) => {
      return candidate === extension;
    }) ||
    file.type.startsWith("video/")
  ) {
    return "video";
  }
  return null;
}

function previewUrlForDraft(draft: IntroVideoDraftRecord): string | null {
  return draft.kind === "document" ? null : URL.createObjectURL(draft.blob);
}

function sourceFromDraft(draft: IntroVideoDraftRecord): IntroVideoSource {
  return {
    blob: draft.blob,
    contentType: draft.contentType,
    durationSeconds: draft.durationSeconds,
    kind: draft.kind,
    name: draft.name,
    previewUrl: previewUrlForDraft(draft),
    size: draft.blob.size,
  };
}

function draftFromSource(source: IntroVideoSource): IntroVideoDraftRecord {
  return {
    blob: source.blob,
    contentType: source.contentType,
    createdAt: now(),
    durationSeconds: source.durationSeconds,
    kind: source.kind,
    name: source.name,
  };
}

function releasePreviewUrl(source: IntroVideoSource | null): void {
  if (source?.previewUrl) {
    URL.revokeObjectURL(source.previewUrl);
  }
}

function recorderMimeType(): string | undefined {
  const supported = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((contentType) => {
    return MediaRecorder.isTypeSupported(contentType);
  });
  return supported;
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

function clearRecordingTimer(runtime: RecordingRuntime): void {
  if (runtime.timer !== null) {
    window.clearInterval(runtime.timer);
    runtime.timer = null;
  }
}

function releaseRecordingRuntime(
  runtime: RecordingRuntime,
  stopRecorder: boolean,
): void {
  clearRecordingTimer(runtime);
  const recorder = runtime.recorder;
  runtime.recorder = null;
  if (stopRecorder && recorder?.state !== "inactive") {
    recorder?.stop();
  }
  stopTracks(runtime.recordingStream);
  stopTracks(runtime.microphoneStream);
  stopTracks(runtime.displayStream);
  runtime.recordingStream = null;
  runtime.microphoneStream = null;
  runtime.displayStream = null;
  if (runtime.audioContext) {
    runtime.audioContextClose = runtime.audioContext.close();
    runtime.audioContext = null;
  }
  if (!runtime.stopCompletionSettled?.()) {
    runtime.stopCompletionResolve?.();
  }
  runtime.stopCompletionResolve = null;
  runtime.stopCompletionSettled = null;
  runtime.stopCompletion = null;
  runtime.chunks = [];
}

async function recordingStreamWithMicrophone(
  runtime: RecordingRuntime,
  displayStream: MediaStream,
  includeMicrophone: boolean,
): Promise<MediaStream> {
  if (!includeMicrophone) {
    return displayStream;
  }

  const microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  runtime.microphoneStream = microphoneStream;
  const videoTracks = displayStream.getVideoTracks();
  const audioTracks = [
    ...displayStream.getAudioTracks(),
    ...microphoneStream.getAudioTracks(),
  ];
  if (audioTracks.length === 0 || typeof AudioContext === "undefined") {
    return new MediaStream([...videoTracks, ...audioTracks]);
  }

  const audioContext = new AudioContext();
  runtime.audioContext = audioContext;
  const destination = audioContext.createMediaStreamDestination();
  for (const audioTrack of audioTracks) {
    audioContext
      .createMediaStreamSource(new MediaStream([audioTrack]))
      .connect(destination);
  }
  return new MediaStream([
    ...videoTracks,
    ...destination.stream.getAudioTracks(),
  ]);
}

function sourceFile(source: IntroVideoSource): File {
  return new File([source.blob], source.name, {
    type: source.contentType,
    lastModified: now(),
  });
}

function voiceSelectionLabel(selection: IntroVideoVoiceSelection | null) {
  switch (selection?.kind) {
    case "catalog": {
      return `${selection.voice.name} (${selection.voice.id})`;
    }
    case "original": {
      return i18n.t(($) => {
        return $.chat.introVideo.voice.original;
      });
    }
    case "none": {
      return i18n.t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
    default: {
      return i18n.t(($) => {
        return $.chat.introVideo.voice.none;
      });
    }
  }
}

export function buildIntroVideoPrompt(args: {
  readonly aspectRatio: "landscape" | "portrait";
  readonly avatar: AvatarVideoAvatar | null;
  readonly instructions: string;
  readonly source: IntroVideoSource;
  readonly voice: IntroVideoVoiceSelection | null;
}): string {
  const aspectRatio = args.aspectRatio === "portrait" ? "9:16" : "16:9";
  const avatar = args.avatar
    ? `${args.avatar.name} (${args.avatar.id})`
    : "No avatar";
  const direction = args.instructions.trim() || DEFAULT_INSTRUCTIONS;
  return [
    "Create a polished intro video from the attached source.",
    "",
    "Configuration:",
    `- Source: ${args.source.name}`,
    `- Source type: ${args.source.kind}`,
    `- Aspect ratio: ${aspectRatio}`,
    `- Avatar: ${avatar}`,
    `- Voice: ${voiceSelectionLabel(args.voice)}`,
    "",
    "Editing direction:",
    direction,
    "",
    "Analyze the source first, remove idle time, emphasize important actions, and use smooth camera pushes around clicks when they improve clarity.",
  ].join("\n");
}

interface IntroVideoInternalState {
  readonly aspectRatio$: State<"landscape" | "portrait">;
  readonly avatar$: State<AvatarVideoAvatar | null>;
  readonly busy$: State<boolean>;
  readonly countdown$: State<number>;
  readonly error$: State<IntroVideoWizardError | null>;
  readonly instructions$: State<string>;
  readonly microphone$: State<boolean>;
  readonly open$: State<boolean>;
  readonly recordingSeconds$: State<number>;
  readonly source$: State<IntroVideoSource | null>;
  readonly sourcePersisted$: State<boolean>;
  readonly sourceUploaded$: State<boolean>;
  readonly step$: State<IntroVideoWizardStep>;
  readonly systemAudio$: State<boolean>;
  readonly voice$: State<IntroVideoVoiceSelection | null>;
}

interface SignalContext {
  readonly get: Getter;
  readonly set: Setter;
}

interface RecordingOperation {
  readonly generation: number;
  readonly internal: IntroVideoInternalState;
  readonly runtime: RecordingRuntime;
}

function createIntroVideoInternalState(): IntroVideoInternalState {
  return {
    aspectRatio$: state<"landscape" | "portrait">("landscape"),
    avatar$: state<AvatarVideoAvatar | null>(null),
    busy$: state(false),
    countdown$: state(3),
    error$: state<IntroVideoWizardError | null>(null),
    instructions$: state(DEFAULT_INSTRUCTIONS),
    microphone$: state(false),
    open$: state(false),
    recordingSeconds$: state(0),
    source$: state<IntroVideoSource | null>(null),
    sourcePersisted$: state(false),
    sourceUploaded$: state(false),
    step$: state<IntroVideoWizardStep>("source"),
    systemAudio$: state(true),
    voice$: state<IntroVideoVoiceSelection | null>(null),
  };
}

function exposeState<T>(signal: State<T>) {
  return computed((get) => {
    return get(signal);
  });
}

function createIntroVideoSelectors(internal: IntroVideoInternalState) {
  return {
    aspectRatio$: exposeState(internal.aspectRatio$),
    avatar$: exposeState(internal.avatar$),
    busy$: exposeState(internal.busy$),
    countdown$: exposeState(internal.countdown$),
    error$: exposeState(internal.error$),
    instructions$: exposeState(internal.instructions$),
    microphone$: exposeState(internal.microphone$),
    open$: exposeState(internal.open$),
    recordingSeconds$: exposeState(internal.recordingSeconds$),
    source$: exposeState(internal.source$),
    sourcePersisted$: exposeState(internal.sourcePersisted$),
    step$: exposeState(internal.step$),
    systemAudio$: exposeState(internal.systemAudio$),
    voice$: exposeState(internal.voice$),
  };
}

function sourceFromFile(
  file: File,
  kind: Exclude<IntroVideoSourceKind, "recording">,
): IntroVideoSource {
  return {
    blob: file,
    contentType: file.type || "application/octet-stream",
    durationSeconds: null,
    kind,
    name: file.name,
    previewUrl: kind === "video" ? URL.createObjectURL(file) : null,
    size: file.size,
  };
}

function createSourceCommands(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
) {
  const openWizard$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      set(internal.open$, true);
      set(internal.error$, null);
      if (get(internal.source$)) {
        return;
      }
      const restored = await settle(readIntroVideoDraft(), signal);
      if (!restored.ok || !restored.value) {
        return;
      }
      set(internal.source$, sourceFromDraft(restored.value));
      set(internal.sourcePersisted$, true);
      set(internal.step$, "source-review");
    },
  );
  const closeWizard$ = command(({ set }) => {
    runtime.generation += 1;
    releaseRecordingRuntime(runtime, true);
    set(internal.busy$, false);
    set(internal.open$, false);
  });
  const setStep$ = command(
    ({ get, set }, nextStep: IntroVideoWizardStep): void => {
      const sourceRequired =
        nextStep !== "source" && nextStep !== "record-setup";
      if (sourceRequired && !get(internal.source$)) {
        return;
      }
      set(internal.error$, null);
      set(internal.step$, nextStep);
    },
  );
  const setSourceFile$ = command(
    async (
      { get, set },
      file: File,
      kind: Exclude<IntroVideoSourceKind, "recording">,
      signal: AbortSignal,
    ): Promise<void> => {
      const source = sourceFromFile(file, kind);
      releasePreviewUrl(get(internal.source$));
      set(internal.source$, source);
      set(internal.sourceUploaded$, false);
      set(internal.sourcePersisted$, false);
      set(internal.error$, null);
      if (get(internal.voice$)?.kind === "original" && kind !== "video") {
        set(internal.voice$, null);
      }
      set(internal.step$, "source-review");
      const persisted = await settle(
        saveIntroVideoDraft(draftFromSource(source)),
        signal,
      );
      set(internal.sourcePersisted$, persisted.ok);
    },
  );
  return { closeWizard$, openWizard$, setSourceFile$, setStep$ };
}

function createSelectionCommands(internal: IntroVideoInternalState) {
  const setSystemAudio$ = command(({ set }, enabled: boolean) => {
    set(internal.systemAudio$, enabled);
  });
  const setMicrophone$ = command(({ set }, enabled: boolean) => {
    set(internal.microphone$, enabled);
  });
  const setAvatar$ = command(
    ({ set }, avatar: AvatarVideoAvatar | null): void => {
      set(internal.avatar$, avatar);
    },
  );
  const setAspectRatio$ = command(
    ({ set }, aspectRatio: "landscape" | "portrait"): void => {
      set(internal.aspectRatio$, aspectRatio);
    },
  );
  const setVoice$ = command(
    ({ set }, voice: IntroVideoVoiceSelection | null): void => {
      set(internal.voice$, voice);
    },
  );
  const setInstructions$ = command(({ set }, instructions: string): void => {
    set(internal.instructions$, instructions);
  });
  return {
    setAspectRatio$,
    setAvatar$,
    setInstructions$,
    setMicrophone$,
    setSystemAudio$,
    setVoice$,
  };
}

function watchSharedSurface(
  { set }: SignalContext,
  operation: RecordingOperation,
  displayStream: MediaStream,
  stopRecording$: Command<Promise<void>, [AbortSignal]>,
  signal: AbortSignal,
): { ended: boolean } {
  const { generation, internal, runtime } = operation;
  const status = { ended: false };
  displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (generation !== runtime.generation) {
      return;
    }
    const recorder = runtime.recorder;
    if (recorder && recorder.state !== "inactive") {
      runtime.stopAction = set(stopRecording$, signal);
      return;
    }
    status.ended = true;
    releaseRecordingRuntime(runtime, false);
    set(internal.busy$, false);
    set(internal.error$, "recording-share-ended");
    set(internal.step$, "record-setup");
  });
  return status;
}

async function runRecordingCountdown(
  context: SignalContext,
  operation: RecordingOperation,
  status: { readonly ended: boolean },
  signal: AbortSignal,
): Promise<boolean> {
  const { set } = context;
  const { generation, internal, runtime } = operation;
  set(internal.step$, "countdown");
  for (let count = 3; count >= 1; count -= 1) {
    set(internal.countdown$, count);
    await delay(1000, { signal });
    if (status.ended || generation !== runtime.generation) {
      return false;
    }
  }
  return true;
}

async function finalizeRecording(
  { get, set }: SignalContext,
  operation: RecordingOperation,
  recorder: MediaRecorder,
  signal: AbortSignal,
): Promise<void> {
  const { generation, internal, runtime } = operation;
  if (generation !== runtime.generation) {
    return;
  }
  const durationSeconds = Math.max(
    0,
    (now() - runtime.recordingStartedAt) / 1000,
  );
  const blob = new Blob(runtime.chunks, {
    type: recorder.mimeType || "video/webm",
  });
  runtime.generation += 1;
  releaseRecordingRuntime(runtime, false);
  set(internal.busy$, false);
  if (blob.size === 0) {
    set(internal.error$, "recording-empty");
    set(internal.step$, "record-setup");
    return;
  }
  const source = sourceFromDraft({
    blob,
    contentType: blob.type || "video/webm",
    createdAt: now(),
    durationSeconds,
    kind: "recording",
    name: RECORDING_FILE_NAME,
  });
  releasePreviewUrl(get(internal.source$));
  set(internal.source$, source);
  set(internal.sourceUploaded$, false);
  set(internal.sourcePersisted$, false);
  set(internal.step$, "source-review");
  const persisted = await settle(
    saveIntroVideoDraft(draftFromSource(source)),
    signal,
  );
  set(internal.sourcePersisted$, persisted.ok);
}

function startMediaRecorder(
  context: SignalContext,
  operation: RecordingOperation,
  recordingStream: MediaStream,
  signal: AbortSignal,
): void {
  const { set } = context;
  const { internal, runtime } = operation;
  runtime.recordingStream = recordingStream;
  runtime.chunks = [];
  const contentType = recorderMimeType();
  const recorder = contentType
    ? new MediaRecorder(recordingStream, { mimeType: contentType })
    : new MediaRecorder(recordingStream);
  runtime.recorder = recorder;
  const completion = createDeferredPromise<void>(signal);
  runtime.stopCompletion = completion.promise;
  runtime.stopCompletionResolve = () => {
    completion.resolve(undefined);
  };
  runtime.stopCompletionSettled = completion.settled;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      runtime.chunks.push(event.data);
    }
  });
  recorder.addEventListener(
    "stop",
    () => {
      if (!completion.settled()) {
        completion.resolve(undefined);
      }
    },
    { once: true, signal },
  );
  recorder.start(1000);
  runtime.recordingStartedAt = now();
  set(internal.step$, "recording");
  set(internal.busy$, false);
  runtime.timer = window.setInterval(() => {
    set(
      internal.recordingSeconds$,
      Math.max(0, Math.floor((now() - runtime.recordingStartedAt) / 1000)),
    );
  }, 250);
}

async function performRecordingAttempt(
  context: SignalContext,
  operation: RecordingOperation,
  stopRecording$: Command<Promise<void>, [AbortSignal]>,
  signal: AbortSignal,
): Promise<void> {
  const { get } = context;
  const { generation, internal, runtime } = operation;
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    audio: get(internal.systemAudio$),
    video: { frameRate: { ideal: 30, max: 30 } },
  });
  signal.throwIfAborted();
  if (generation !== runtime.generation) {
    stopTracks(displayStream);
    return;
  }
  runtime.displayStream = displayStream;
  const status = watchSharedSurface(
    context,
    operation,
    displayStream,
    stopRecording$,
    signal,
  );
  if (!(await runRecordingCountdown(context, operation, status, signal))) {
    return;
  }
  const recordingStream = await recordingStreamWithMicrophone(
    runtime,
    displayStream,
    get(internal.microphone$),
  );
  signal.throwIfAborted();
  if (generation !== runtime.generation) {
    stopTracks(recordingStream);
    return;
  }
  startMediaRecorder(context, operation, recordingStream, signal);
}

function recordingError(error: unknown): IntroVideoWizardError {
  const name =
    error instanceof Error || error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError"
    ? "recording-permission"
    : "recording-failed";
}

function createRecordingCommands(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
) {
  const stopRecording$ = command(
    async (context, signal: AbortSignal): Promise<void> => {
      const { set } = context;
      signal.throwIfAborted();
      const recorder = runtime.recorder;
      const completion = runtime.stopCompletion;
      if (!recorder || !completion || recorder.state === "inactive") {
        return;
      }
      const operation = {
        generation: runtime.generation,
        internal,
        runtime,
      };
      set(internal.busy$, true);
      clearRecordingTimer(runtime);
      recorder.stop();
      await completion;
      signal.throwIfAborted();
      await finalizeRecording(context, operation, recorder, signal);
      runtime.stopAction = null;
    },
  );
  const startRecording$ = command(
    async (context, signal: AbortSignal): Promise<void> => {
      const { get, set } = context;
      if (
        !navigator.mediaDevices?.getDisplayMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        set(internal.error$, "recording-unsupported");
        return;
      }
      runtime.generation += 1;
      const generation = runtime.generation;
      releaseRecordingRuntime(runtime, true);
      if (runtime.audioContextClose) {
        await settle(runtime.audioContextClose, signal);
        runtime.audioContextClose = null;
      }
      set(internal.busy$, true);
      set(internal.error$, null);
      set(internal.recordingSeconds$, 0);
      const operation = { generation, internal, runtime };
      const attempt = await settle(
        performRecordingAttempt(context, operation, stopRecording$, signal),
        signal,
      );
      if (!attempt.ok) {
        releaseRecordingRuntime(runtime, true);
        set(internal.busy$, false);
        set(internal.error$, recordingError(attempt.error));
        set(internal.step$, "record-setup");
        return;
      }
      if (get(internal.step$) !== "recording") {
        set(internal.busy$, false);
      }
    },
  );
  const setRecordingPreviewRef$ = onRef(
    command(
      async (
        _context,
        video: HTMLVideoElement,
        signal: AbortSignal,
      ): Promise<void> => {
        video.srcObject = runtime.displayStream;
        video.muted = true;
        video.playsInline = true;
        signal.addEventListener(
          "abort",
          () => {
            video.srcObject = null;
          },
          { once: true },
        );
        await video.play();
        signal.throwIfAborted();
      },
    ),
  );
  return { setRecordingPreviewRef$, startRecording$, stopRecording$ };
}

function createDownloadSourceCommand(internal: IntroVideoInternalState) {
  return command(({ get }): void => {
    const source = get(internal.source$);
    if (!source) {
      return;
    }
    const url = URL.createObjectURL(source.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = source.name;
    anchor.click();
    URL.revokeObjectURL(url);
  });
}

async function uploadSourceIfNeeded(
  { get, set }: SignalContext,
  args: {
    readonly composer: ComposerSignals;
    readonly downloadSource$: Command<void, []>;
    readonly internal: IntroVideoInternalState;
    readonly source: IntroVideoSource;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const { composer, downloadSource$, internal, source } = args;
  if (get(internal.sourceUploaded$)) {
    return true;
  }
  const before = new Set(get(composer.draft.attachments$));
  await set(composer.draft.uploadAttachment$, sourceFile(source), signal);
  signal.throwIfAborted();
  const uploaded = get(composer.draft.attachments$).some((attachment) => {
    return !before.has(attachment);
  });
  if (!uploaded) {
    set(internal.busy$, false);
    set(internal.error$, "upload-failed");
    set(downloadSource$);
    return false;
  }
  set(internal.sourceUploaded$, true);
  return true;
}

async function clearCompletedDraft(
  { set }: SignalContext,
  internal: IntroVideoInternalState,
  source: IntroVideoSource,
  signal: AbortSignal,
): Promise<void> {
  // The server owns the uploaded source after send. If local cleanup fails,
  // the stale draft is harmless and can be replaced on the next open.
  await settle(deleteIntroVideoDraft(), signal);
  releasePreviewUrl(source);
  set(internal.source$, null);
  set(internal.sourcePersisted$, false);
  set(internal.sourceUploaded$, false);
  set(internal.avatar$, null);
  set(internal.voice$, null);
  set(internal.instructions$, DEFAULT_INSTRUCTIONS);
  set(internal.step$, "source");
  set(internal.busy$, false);
  set(internal.open$, false);
}

async function submitComposer(
  { get, set }: SignalContext,
  composer: ComposerSignals,
  signal: AbortSignal,
): Promise<boolean> {
  const action = await get(composer.submission.primaryAction$);
  signal.throwIfAborted();
  return await set(composer.submission.submitCurrentInput$, action, signal);
}

function createSubmissionCommands(
  internal: IntroVideoInternalState,
  downloadSource$: Command<void, []>,
) {
  const submitDirectChat$ = command(
    async (
      context,
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const { set } = context;
      set(internal.busy$, true);
      set(internal.error$, null);
      set(
        composer.draft.setDraftInput$,
        "Help me create an intro video. Ask me for the source, audience, avatar, voice, and editing direction before generating it.",
      );
      const submission = await settle(
        submitComposer(context, composer, signal),
        signal,
      );
      set(internal.busy$, false);
      if (!submission.ok || !submission.value) {
        set(internal.error$, "send-failed");
        return false;
      }
      set(internal.open$, false);
      return true;
    },
  );
  const submit$ = command(
    async (
      context,
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const { get, set } = context;
      const source = get(internal.source$);
      if (!source) {
        set(internal.step$, "source");
        return false;
      }
      set(internal.busy$, true);
      set(internal.error$, null);
      if (
        !(await uploadSourceIfNeeded(
          context,
          { composer, downloadSource$, internal, source },
          signal,
        ))
      ) {
        return false;
      }
      set(
        composer.draft.setDraftInput$,
        buildIntroVideoPrompt({
          aspectRatio: get(internal.aspectRatio$),
          avatar: get(internal.avatar$),
          instructions: get(internal.instructions$),
          source,
          voice: get(internal.voice$),
        }),
      );
      const submission = await settle(
        submitComposer(context, composer, signal),
        signal,
      );
      if (!submission.ok || !submission.value) {
        set(internal.busy$, false);
        set(internal.error$, "send-failed");
        set(downloadSource$);
        return false;
      }
      await clearCompletedDraft(context, internal, source, signal);
      return true;
    },
  );
  return { submit$, submitDirectChat$ };
}

function createIntroVideoWizardSignals() {
  const internal = createIntroVideoInternalState();
  const runtime = createRecordingRuntime();
  const selectors = createIntroVideoSelectors(internal);
  const sourceCommands = createSourceCommands(internal, runtime);
  const selectionCommands = createSelectionCommands(internal);
  const recordingCommands = createRecordingCommands(internal, runtime);
  const downloadSource$ = createDownloadSourceCommand(internal);
  const submissionCommands = createSubmissionCommands(
    internal,
    downloadSource$,
  );
  return {
    ...selectors,
    ...sourceCommands,
    ...selectionCommands,
    ...recordingCommands,
    ...submissionCommands,
    downloadSource$,
  };
}

export const introVideoWizardSignals = createIntroVideoWizardSignals();
