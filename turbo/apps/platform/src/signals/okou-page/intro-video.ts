import type {
  AvatarVideoAvatar,
  AvatarVideoVoice,
} from "@okouai/api-contracts/contracts/avatar-video";
import { command, computed, state, type Command, type State } from "ccstate";
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
import { INTRO_VIDEO_AGENT_INSTRUCTIONS } from "./intro-video-agent-instructions.ts";
import {
  createDeferredPromise,
  onRef,
  onRejection,
  resetSignal,
  setLoop,
  settle,
  withCleanup,
} from "../utils.ts";

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

interface IntroVideoSourceFacts {
  readonly contentType: string;
  readonly durationSeconds: number | null;
  readonly kind: IntroVideoSourceKind;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly size: number;
}

/**
 * A source this browser still holds the bytes for. It is kept in the local
 * draft store so a reload can restore it, and uploaded when the wizard submits.
 */
interface LocalIntroVideoSource extends IntroVideoSourceFacts {
  readonly blob: Blob;
  readonly origin: "local";
}

/**
 * A source that was already stored before the wizard saw it. The desktop
 * recorder uploads the recording and its click track and only then hands the
 * browser a link, so there are no local bytes to persist, to upload again at
 * submit, or to hand back when sending fails.
 */
interface UploadedIntroVideoSource extends IntroVideoSourceFacts {
  readonly origin: "uploaded";
}

export type IntroVideoSource = LocalIntroVideoSource | UploadedIntroVideoSource;

/**
 * Metadata for an already-uploaded recording the wizard adopts as its source.
 *
 * `previewUrl` is resolved by the caller against the owning file API, so it is
 * null when that account cannot read the artifact.
 */
interface AdoptedIntroVideoRecording {
  readonly attachmentIds: readonly string[];
  readonly contentType: string;
  readonly name: string;
  readonly previewUrl: string | null;
  readonly size: number;
}

export type IntroVideoVoiceSelection =
  | { readonly kind: "catalog"; readonly voice: AvatarVideoVoice }
  | { readonly kind: "none" }
  | { readonly kind: "original" };

export type IntroVideoVisualBalance = "avatar-led" | "b-roll-led" | "balanced";

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
}

const DOCUMENT_EXTENSIONS = ["doc", "docx", "pdf", "ppt", "pptx"] as const;
const VIDEO_EXTENSIONS = ["mov", "mp4", "webm"] as const;
const DEFAULT_INSTRUCTIONS =
  "Create a concise 30 second product intro. Zoom in on important actions, remove pauses, and keep the pacing energetic.";
const RECORDING_FILE_NAME = "Screen recording.webm";
/**
 * Aspect ratio reported to the agent for the raw avatar take.
 *
 * The wizard no longer asks for one: the take is composited by HyperFrames,
 * which reframes it and decides the delivered aspect ratio. The value is still
 * reported because it is what the avatar-video request is generated with.
 */
export const INTRO_VIDEO_ASPECT_RATIO_LABEL = "16:9";

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

function sourceFromDraft(draft: IntroVideoDraftRecord): LocalIntroVideoSource {
  return {
    blob: draft.blob,
    contentType: draft.contentType,
    durationSeconds: draft.durationSeconds,
    kind: draft.kind,
    name: draft.name,
    origin: "local",
    previewUrl: previewUrlForDraft(draft),
    size: draft.blob.size,
  };
}

function draftFromSource(source: LocalIntroVideoSource): IntroVideoDraftRecord {
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
  // Only a local source owns its preview URL. An uploaded source previews from
  // a signed address the file API handed out, which is not ours to revoke.
  if (source?.origin === "local" && source.previewUrl) {
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

function releaseRecordingRuntime(
  runtime: RecordingRuntime,
  stopRecorder: boolean,
): void {
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
  signal: AbortSignal,
): Promise<MediaStream> {
  if (!includeMicrophone) {
    return displayStream;
  }

  const microphoneStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  if (signal.aborted) {
    stopTracks(microphoneStream);
    signal.throwIfAborted();
  }
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

async function recordingDisplayStream(
  includeSystemAudio: boolean,
  signal: AbortSignal,
): Promise<MediaStream> {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    audio: includeSystemAudio,
    video: { frameRate: { ideal: 30, max: 30 } },
  });
  if (signal.aborted) {
    stopTracks(displayStream);
    signal.throwIfAborted();
  }
  return displayStream;
}

function sourceFile(source: LocalIntroVideoSource): File {
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

function buildIntroVideoPrompt(args: {
  readonly avatar: AvatarVideoAvatar | null;
  readonly instructions: string;
  readonly source: IntroVideoSource;
  readonly visualBalance: IntroVideoVisualBalance;
  readonly voice: IntroVideoVoiceSelection | null;
}): string {
  const avatar = args.avatar
    ? `${args.avatar.name} (${args.avatar.id})`
    : "No avatar";
  const visualBalanceDescription: Record<IntroVideoVisualBalance, string> = {
    "avatar-led": "Avatar-led (presenter on screen most of the time)",
    "b-roll-led": "B-roll-led (focus on slides and source visuals)",
    balanced: "Balanced mix (roughly equal time for presenter and visuals)",
  };
  const direction = args.instructions.trim() || DEFAULT_INSTRUCTIONS;
  return [
    "Create a polished intro video from the attached source.",
    "",
    "Configuration:",
    `- Source: ${args.source.name}`,
    `- Source type: ${args.source.kind}`,
    `- Aspect ratio: ${INTRO_VIDEO_ASPECT_RATIO_LABEL}`,
    `- Avatar: ${avatar}`,
    `- Voice: ${voiceSelectionLabel(args.voice)}`,
    ...(args.avatar?.coverUrl
      ? [`- Avatar cutout (transparent still): ${args.avatar.coverUrl}`]
      : []),
    ...(args.avatar
      ? [
          "- Avatar background: transparent WebM (JoggAI screen_style 3, which requires captions off)",
          `- Visual balance: ${visualBalanceDescription[args.visualBalance]}`,
        ]
      : []),
    "",
    "Editing direction:",
    direction,
  ].join("\n");
}

interface IntroVideoInternalState {
  /**
   * Uploads the wizard adopted from a desktop handoff, which are already
   * attached to the composer. Remembered so replacing the source can take them
   * back off the draft instead of sending a stale recording beside the new one.
   */
  readonly adoptedAttachmentIds$: State<readonly string[]>;
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
  readonly visualBalance$: State<IntroVideoVisualBalance>;
  readonly voice$: State<IntroVideoVoiceSelection | null>;
}

function createIntroVideoInternalState(): IntroVideoInternalState {
  return {
    adoptedAttachmentIds$: state<readonly string[]>([]),
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
    visualBalance$: state<IntroVideoVisualBalance>("balanced"),
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
    visualBalance$: exposeState(internal.visualBalance$),
    voice$: exposeState(internal.voice$),
  };
}

function sourceFromFile(
  file: File,
  kind: Exclude<IntroVideoSourceKind, "recording">,
): LocalIntroVideoSource {
  return {
    blob: file,
    contentType: file.type || "application/octet-stream",
    durationSeconds: null,
    kind,
    name: file.name,
    origin: "local",
    previewUrl: kind === "video" ? URL.createObjectURL(file) : null,
    size: file.size,
  };
}

/**
 * Takes the adopted uploads back off the composer draft.
 *
 * The handoff attaches the recording and its click track so the wizard has
 * nothing left to upload. Once the user picks a different source those files
 * are no longer part of the request, and leaving them attached would send the
 * agent two competing recordings.
 */
function createDiscardAdoptedAttachmentsCommand(
  internal: IntroVideoInternalState,
) {
  return command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<void> => {
      const adopted = get(internal.adoptedAttachmentIds$);
      if (adopted.length === 0) {
        return;
      }
      set(internal.adoptedAttachmentIds$, []);
      const resolved = await Promise.all(
        get(composer.draft.attachments$).map(async (attachment) => {
          return { attachment, info: await get(attachment.fileInfo$) };
        }),
      );
      signal.throwIfAborted();
      for (const { attachment, info } of resolved) {
        if (info && adopted.includes(info.id)) {
          set(composer.draft.removeAttachment$, attachment);
        }
      }
    },
  );
}

function createSourceCommands(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
  resetRecordingAttempt$: ReturnType<typeof resetSignal>,
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
  const closeWizard$ = command(({ get, set }) => {
    runtime.generation += 1;
    set(resetRecordingAttempt$);
    releaseRecordingRuntime(runtime, true);
    set(internal.busy$, false);
    set(internal.countdown$, 3);
    set(internal.recordingSeconds$, 0);
    const step = get(internal.step$);
    if (step === "countdown" || step === "recording") {
      set(internal.step$, "record-setup");
    }
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
  const adoptUploadedRecording$ = command(
    ({ get, set }, recording: AdoptedIntroVideoRecording): void => {
      releasePreviewUrl(get(internal.source$));
      set(internal.source$, {
        contentType: recording.contentType,
        durationSeconds: null,
        kind: "recording",
        name: recording.name,
        origin: "uploaded",
        previewUrl: recording.previewUrl,
        size: recording.size,
      });
      set(internal.adoptedAttachmentIds$, recording.attachmentIds);
      // The bytes are already stored under this account, so submit has nothing
      // to upload and the local draft store has nothing worth holding.
      set(internal.sourceUploaded$, true);
      set(internal.sourcePersisted$, false);
      set(internal.error$, null);
      set(internal.step$, "source-review");
      set(internal.open$, true);
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
  return {
    adoptUploadedRecording$,
    closeWizard$,
    openWizard$,
    setSourceFile$,
    setStep$,
  };
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
  const setVoice$ = command(
    ({ set }, voice: IntroVideoVoiceSelection | null): void => {
      set(internal.voice$, voice);
    },
  );
  const setInstructions$ = command(({ set }, instructions: string): void => {
    set(internal.instructions$, instructions);
  });
  const setVisualBalance$ = command(
    ({ set }, visualBalance: IntroVideoVisualBalance): void => {
      set(internal.visualBalance$, visualBalance);
    },
  );
  return {
    setAvatar$,
    setInstructions$,
    setMicrophone$,
    setSystemAudio$,
    setVisualBalance$,
    setVoice$,
  };
}

function watchSharedSurface(
  runtime: RecordingRuntime,
  generation: number,
  displayStream: MediaStream,
  signal: AbortSignal,
): { ended: boolean } {
  const status = { ended: false };
  displayStream.getVideoTracks()[0]?.addEventListener(
    "ended",
    () => {
      if (generation !== runtime.generation) {
        return;
      }
      status.ended = true;
      const recorder = runtime.recorder;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
    },
    { signal },
  );
  return status;
}

function recordingError(error: unknown): IntroVideoWizardError {
  const name =
    error instanceof Error || error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError"
    ? "recording-permission"
    : "recording-failed";
}

function createRecordingProgressCommands(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
) {
  const runRecordingCountdown$ = command(
    async (
      { set },
      generation: number,
      status: { readonly ended: boolean },
      signal: AbortSignal,
    ): Promise<boolean> => {
      set(internal.step$, "countdown");
      for (let count = 3; count >= 1; count -= 1) {
        set(internal.countdown$, count);
        await delay(1000, { signal });
        if (status.ended || generation !== runtime.generation) {
          return false;
        }
      }
      return true;
    },
  );
  const updateRecordingSeconds$ = command(
    async ({ set }, generation: number, signal: AbortSignal): Promise<void> => {
      const recordingIsActive = () => {
        return (
          generation === runtime.generation &&
          runtime.recorder?.state === "recording"
        );
      };
      let isFirstIteration = true;
      await setLoop(
        () => {
          if (!recordingIsActive()) {
            return true;
          }
          if (isFirstIteration) {
            isFirstIteration = false;
            return false;
          }
          set(
            internal.recordingSeconds$,
            Math.max(
              0,
              Math.floor((now() - runtime.recordingStartedAt) / 1000),
            ),
          );
          return false;
        },
        250,
        signal,
      );
    },
  );
  return { runRecordingCountdown$, updateRecordingSeconds$ };
}

function createRecordingCompletionCommands(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
) {
  const finalizeRecording$ = command(
    async (
      { get, set },
      generation: number,
      recorder: MediaRecorder,
      signal: AbortSignal,
    ): Promise<void> => {
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
    },
  );
  const startMediaRecorder$ = command(
    (
      { set },
      recordingStream: MediaStream,
      signal: AbortSignal,
    ): {
      readonly completion: Promise<void>;
      readonly recorder: MediaRecorder;
    } => {
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
      return { completion: completion.promise, recorder };
    },
  );
  return { finalizeRecording$, startMediaRecorder$ };
}

function createRecordingAttemptCommand(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
  progress: ReturnType<typeof createRecordingProgressCommands>,
  completion: ReturnType<typeof createRecordingCompletionCommands>,
) {
  const { runRecordingCountdown$, updateRecordingSeconds$ } = progress;
  const { finalizeRecording$, startMediaRecorder$ } = completion;
  const performRecordingAttempt$ = command(
    async (
      { get, set },
      generation: number,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const displayStream = await recordingDisplayStream(
        get(internal.systemAudio$),
        signal,
      );
      signal.throwIfAborted();
      if (generation !== runtime.generation) {
        stopTracks(displayStream);
        return false;
      }
      runtime.displayStream = displayStream;
      const status = watchSharedSurface(
        runtime,
        generation,
        displayStream,
        signal,
      );
      if (
        !(await set(runRecordingCountdown$, generation, status, signal)) ||
        status.ended
      ) {
        return false;
      }
      const recordingStream = await recordingStreamWithMicrophone(
        runtime,
        displayStream,
        get(internal.microphone$),
        signal,
      );
      if (signal.aborted || status.ended || generation !== runtime.generation) {
        stopTracks(recordingStream);
        signal.throwIfAborted();
        return false;
      }
      const recording = set(startMediaRecorder$, recordingStream, signal);
      await Promise.all([
        recording.completion,
        set(updateRecordingSeconds$, generation, signal),
      ]);
      signal.throwIfAborted();
      if (generation !== runtime.generation) {
        return true;
      }
      set(internal.busy$, true);
      await set(finalizeRecording$, generation, recording.recorder, signal);
      return true;
    },
  );
  return performRecordingAttempt$;
}

function createStartRecordingCommand(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
  resetRecordingAttempt$: ReturnType<typeof resetSignal>,
  performRecordingAttempt$: ReturnType<typeof createRecordingAttemptCommand>,
) {
  const abortRecording$ = command(({ set }, generation: number): void => {
    if (generation !== runtime.generation) {
      return;
    }
    runtime.generation += 1;
    releaseRecordingRuntime(runtime, true);
    set(internal.busy$, false);
    set(internal.countdown$, 3);
    set(internal.recordingSeconds$, 0);
    set(internal.error$, null);
    set(internal.step$, "record-setup");
    set(internal.open$, false);
  });
  return command(async ({ set }, parentSignal: AbortSignal): Promise<void> => {
    if (
      !navigator.mediaDevices?.getDisplayMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      set(internal.error$, "recording-unsupported");
      return;
    }
    const signal = set(resetRecordingAttempt$, parentSignal);
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
    const aborted = createDeferredPromise<never>(signal);
    const attempt = await onRejection(
      settle(
        withCleanup(
          Promise.race([
            set(performRecordingAttempt$, generation, signal),
            aborted.promise,
          ]),
          () => {
            if (!aborted.settled()) {
              aborted.reject(
                new DOMException("Recording attempt settled", "AbortError"),
              );
            }
          },
        ),
        signal,
      ),
      () => {
        set(abortRecording$, generation);
      },
    );
    if (generation !== runtime.generation) {
      return;
    }
    if (!attempt.ok) {
      runtime.generation += 1;
      releaseRecordingRuntime(runtime, true);
      set(internal.busy$, false);
      set(internal.error$, recordingError(attempt.error));
      set(internal.step$, "record-setup");
      return;
    }
    if (!attempt.value) {
      runtime.generation += 1;
      releaseRecordingRuntime(runtime, true);
      set(internal.busy$, false);
      set(internal.error$, "recording-share-ended");
      set(internal.step$, "record-setup");
    }
  });
}

function createRecordingCommands(
  internal: IntroVideoInternalState,
  runtime: RecordingRuntime,
  resetRecordingAttempt$: ReturnType<typeof resetSignal>,
) {
  const progress = createRecordingProgressCommands(internal, runtime);
  const completion = createRecordingCompletionCommands(internal, runtime);
  const performRecordingAttempt$ = createRecordingAttemptCommand(
    internal,
    runtime,
    progress,
    completion,
  );
  const startRecording$ = createStartRecordingCommand(
    internal,
    runtime,
    resetRecordingAttempt$,
    performRecordingAttempt$,
  );
  const stopRecording$ = command(({ set }, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const recorder = runtime.recorder;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    set(internal.busy$, true);
    recorder.stop();
  });
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
    // An uploaded source is already safe on the server, so there is nothing
    // local to hand back when a send fails.
    if (source?.origin !== "local") {
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

function createClearCompletedDraftCommand(internal: IntroVideoInternalState) {
  return command(
    async (
      { set },
      source: IntroVideoSource,
      signal: AbortSignal,
    ): Promise<void> => {
      // A stale local draft is harmless if cleanup fails after the server send.
      await settle(deleteIntroVideoDraft(), signal);
      releasePreviewUrl(source);
      set(internal.source$, null);
      set(internal.adoptedAttachmentIds$, []);
      set(internal.sourcePersisted$, false);
      set(internal.sourceUploaded$, false);
      set(internal.avatar$, null);
      set(internal.voice$, null);
      set(internal.instructions$, DEFAULT_INSTRUCTIONS);
      set(internal.visualBalance$, "balanced");
      set(internal.step$, "source");
      set(internal.busy$, false);
      set(internal.open$, false);
    },
  );
}

function createSubmissionCommands(
  internal: IntroVideoInternalState,
  downloadSource$: Command<void, []>,
  discardAdoptedAttachments$: ReturnType<
    typeof createDiscardAdoptedAttachmentsCommand
  >,
) {
  const uploadSourceIfNeeded$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      source: IntroVideoSource,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (source.origin === "uploaded" || get(internal.sourceUploaded$)) {
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
    },
  );
  const clearCompletedDraft$ = createClearCompletedDraftCommand(internal);
  const submitComposer$ = command(
    async (
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const action = await get(composer.submission.primaryAction$);
      signal.throwIfAborted();
      return await set(composer.submission.submitCurrentInput$, action, signal);
    },
  );
  const submitDirectChat$ = command(
    async (
      { set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      set(internal.busy$, true);
      set(internal.error$, null);
      set(composer.draft.setAgentInstructions$, INTRO_VIDEO_AGENT_INSTRUCTIONS);
      set(
        composer.draft.setDraftInput$,
        "Help me create an intro video. Ask me for the source, audience, avatar, voice, and editing direction before generating it.",
      );
      const submission = await settle(
        set(submitComposer$, composer, signal),
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
      { get, set },
      composer: ComposerSignals,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const source = get(internal.source$);
      if (!source) {
        set(internal.step$, "source");
        return false;
      }
      set(internal.busy$, true);
      set(internal.error$, null);
      if (source.origin === "local") {
        // The user replaced an adopted handoff source. Its uploads are still on
        // the draft and are no longer part of this request.
        await set(discardAdoptedAttachments$, composer, signal);
      }
      if (!(await set(uploadSourceIfNeeded$, composer, source, signal))) {
        return false;
      }
      set(composer.draft.setAgentInstructions$, INTRO_VIDEO_AGENT_INSTRUCTIONS);
      set(
        composer.draft.setDraftInput$,
        buildIntroVideoPrompt({
          avatar: get(internal.avatar$),
          instructions: get(internal.instructions$),
          source,
          visualBalance: get(internal.visualBalance$),
          voice: get(internal.voice$),
        }),
      );
      const submission = await settle(
        set(submitComposer$, composer, signal),
        signal,
      );
      if (!submission.ok || !submission.value) {
        set(internal.sourceUploaded$, false);
        set(internal.busy$, false);
        set(internal.error$, "send-failed");
        set(downloadSource$);
        return false;
      }
      await set(clearCompletedDraft$, source, signal);
      return true;
    },
  );
  return { submit$, submitDirectChat$ };
}

function createIntroVideoWizardSignals() {
  const internal = createIntroVideoInternalState();
  const runtime = createRecordingRuntime();
  const resetRecordingAttempt$ = resetSignal();
  const selectors = createIntroVideoSelectors(internal);
  const sourceCommands = createSourceCommands(
    internal,
    runtime,
    resetRecordingAttempt$,
  );
  const selectionCommands = createSelectionCommands(internal);
  const recordingCommands = createRecordingCommands(
    internal,
    runtime,
    resetRecordingAttempt$,
  );
  const downloadSource$ = createDownloadSourceCommand(internal);
  const discardAdoptedAttachments$ =
    createDiscardAdoptedAttachmentsCommand(internal);
  const submissionCommands = createSubmissionCommands(
    internal,
    downloadSource$,
    discardAdoptedAttachments$,
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
