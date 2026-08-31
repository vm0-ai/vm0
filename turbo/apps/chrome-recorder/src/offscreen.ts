import {
  extensionMessage,
  isRuntimeMessage,
  type CaptureSelection,
  type OffscreenMessage,
  type RecorderSessionStatus,
  type RecorderStateSnapshot,
  type WorkerMessage,
} from "./messages.ts";
import { saveRecording } from "./recording-store.ts";

interface OkouCaptureController {
  setFocusBehavior(behavior: "focus-captured-surface"): void;
}

type OkouCaptureControllerConstructor = new () => OkouCaptureController;

interface OkouDisplayMediaOptions extends DisplayMediaStreamOptions {
  readonly controller?: OkouCaptureController;
  readonly selfBrowserSurface?: "exclude";
  readonly surfaceSwitching?: "exclude";
}

interface CaptureRuntime {
  audioContext: AudioContext | null;
  chunks: Blob[];
  displayStream: MediaStream | null;
  elapsedMs: number;
  finalizing: boolean;
  microphoneStream: MediaStream | null;
  recorder: MediaRecorder | null;
  recordingStream: MediaStream | null;
  segmentStartedAt: number;
  sessionId: string | null;
  status: RecorderSessionStatus;
  tabAudio: boolean;
}

const runtime: CaptureRuntime = {
  audioContext: null,
  chunks: [],
  displayStream: null,
  elapsedMs: 0,
  finalizing: false,
  microphoneStream: null,
  recorder: null,
  recordingStream: null,
  segmentStartedAt: 0,
  sessionId: null,
  status: "ready",
  tabAudio: false,
};

function captureController(): OkouCaptureController | undefined {
  const constructor = (
    globalThis as typeof globalThis & {
      readonly CaptureController?: OkouCaptureControllerConstructor;
    }
  ).CaptureController;
  if (!constructor) {
    return undefined;
  }
  const controller = new constructor();
  controller.setFocusBehavior("focus-captured-surface");
  return controller;
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }
}

function elapsedMilliseconds(): number {
  return (
    runtime.elapsedMs +
    (runtime.status === "recording"
      ? Math.max(0, Date.now() - runtime.segmentStartedAt)
      : 0)
  );
}

function stateSnapshot(): RecorderStateSnapshot {
  return {
    elapsedSeconds: elapsedMilliseconds() / 1000,
    microphone: runtime.microphoneStream !== null,
    status: runtime.status,
    tabAudio: runtime.tabAudio,
  };
}

async function publishState(): Promise<void> {
  if (!runtime.sessionId) {
    return;
  }
  await chrome.runtime.sendMessage(
    extensionMessage({
      recipient: "worker",
      sessionId: runtime.sessionId,
      state: stateSnapshot(),
      type: "offscreen:state",
    }),
  );
}

async function publishError(
  code: Extract<WorkerMessage, { readonly type: "offscreen:error" }>["code"],
): Promise<void> {
  if (!runtime.sessionId) {
    return;
  }
  await chrome.runtime.sendMessage(
    extensionMessage({
      code,
      recipient: "worker",
      sessionId: runtime.sessionId,
      type: "offscreen:error",
    }),
  );
}

async function releaseCapture(): Promise<void> {
  stopTracks(runtime.recordingStream);
  stopTracks(runtime.microphoneStream);
  stopTracks(runtime.displayStream);
  runtime.recordingStream = null;
  runtime.microphoneStream = null;
  runtime.displayStream = null;
  if (runtime.audioContext) {
    await runtime.audioContext.close();
    runtime.audioContext = null;
  }
  runtime.chunks = [];
  runtime.recorder = null;
  runtime.elapsedMs = 0;
  runtime.segmentStartedAt = 0;
  runtime.finalizing = false;
  runtime.sessionId = null;
  runtime.status = "ready";
  runtime.tabAudio = false;
}

function recorderMimeType(): string | undefined {
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((contentType) => {
    return MediaRecorder.isTypeSupported(contentType);
  });
}

async function selectSource(sessionId: string): Promise<CaptureSelection> {
  if (runtime.sessionId) {
    await releaseCapture();
  }
  runtime.sessionId = sessionId;
  const controller = captureController();
  const options: OkouDisplayMediaOptions = {
    audio: true,
    controller,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    video: { frameRate: { ideal: 30, max: 30 } },
  };

  try {
    const displayStream = await navigator.mediaDevices.getDisplayMedia(options);
    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack || videoTrack.getSettings().displaySurface !== "browser") {
      stopTracks(displayStream);
      await releaseCapture();
      return { ok: false, reason: "tab-required" };
    }
    runtime.displayStream = displayStream;
    runtime.tabAudio = displayStream.getAudioTracks().length > 0;
    runtime.status = "ready";
    videoTrack.addEventListener(
      "ended",
      () => {
        void finishRecording("capture-ended");
      },
      { once: true },
    );
    return { ok: true, tabAudio: runtime.tabAudio };
  } catch (error) {
    await releaseCapture();
    const name =
      error instanceof Error || error instanceof DOMException ? error.name : "";
    return {
      ok: false,
      reason: name === "NotAllowedError" ? "cancelled" : "failed",
    };
  }
}

async function setMicrophone(enabled: boolean): Promise<void> {
  if (runtime.status !== "ready") {
    return;
  }
  if (!enabled) {
    stopTracks(runtime.microphoneStream);
    runtime.microphoneStream = null;
    await publishState();
    return;
  }
  if (runtime.microphoneStream) {
    return;
  }
  try {
    runtime.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    await publishState();
  } catch {
    await publishError("microphone-permission");
  }
}

function combinedRecordingStream(): MediaStream {
  const displayStream = runtime.displayStream;
  if (!displayStream) {
    throw new Error("A display stream is required before recording");
  }
  const microphoneStream = runtime.microphoneStream;
  if (!microphoneStream) {
    return displayStream;
  }

  const audioTracks = [
    ...displayStream.getAudioTracks(),
    ...microphoneStream.getAudioTracks(),
  ];
  if (audioTracks.length === 0) {
    return new MediaStream(displayStream.getVideoTracks());
  }
  const context = new AudioContext();
  runtime.audioContext = context;
  const destination = context.createMediaStreamDestination();
  for (const audioTrack of audioTracks) {
    context
      .createMediaStreamSource(new MediaStream([audioTrack]))
      .connect(destination);
  }
  return new MediaStream([
    ...displayStream.getVideoTracks(),
    ...destination.stream.getAudioTracks(),
  ]);
}

async function finalizeRecording(
  sessionId: string,
  recorder: MediaRecorder,
): Promise<void> {
  if (runtime.sessionId !== sessionId) {
    return;
  }
  const durationSeconds = elapsedMilliseconds() / 1000;
  const contentType = recorder.mimeType || "video/webm";
  const blob = new Blob(runtime.chunks, { type: contentType });
  if (blob.size === 0) {
    await publishError("capture-failed");
    await releaseCapture();
    return;
  }
  await saveRecording({
    blob,
    contentType,
    createdAt: Date.now(),
    durationSeconds,
    name: "Okou recording.webm",
    sessionId,
  });
  await chrome.runtime.sendMessage(
    extensionMessage({
      durationSeconds,
      recipient: "worker",
      sessionId,
      type: "offscreen:completed",
    }),
  );
  await releaseCapture();
}

async function startRecording(): Promise<void> {
  if (
    runtime.status !== "ready" ||
    !runtime.sessionId ||
    !runtime.displayStream
  ) {
    return;
  }
  const sessionId = runtime.sessionId;
  const recordingStream = combinedRecordingStream();
  runtime.recordingStream = recordingStream;
  runtime.chunks = [];
  const contentType = recorderMimeType();
  const recorder = contentType
    ? new MediaRecorder(recordingStream, { mimeType: contentType })
    : new MediaRecorder(recordingStream);
  runtime.recorder = recorder;
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      runtime.chunks.push(event.data);
    }
  });
  recorder.addEventListener(
    "stop",
    () => {
      void finalizeRecording(sessionId, recorder);
    },
    { once: true },
  );
  runtime.elapsedMs = 0;
  runtime.segmentStartedAt = Date.now();
  runtime.status = "recording";
  recorder.start(1000);
  await publishState();
}

async function pauseRecording(): Promise<void> {
  if (
    runtime.status !== "recording" ||
    runtime.recorder?.state !== "recording"
  ) {
    return;
  }
  runtime.elapsedMs = elapsedMilliseconds();
  runtime.recorder.pause();
  runtime.status = "paused";
  await publishState();
}

async function resumeRecording(): Promise<void> {
  if (runtime.status !== "paused" || runtime.recorder?.state !== "paused") {
    return;
  }
  runtime.segmentStartedAt = Date.now();
  runtime.recorder.resume();
  runtime.status = "recording";
  await publishState();
}

async function finishRecording(
  reason: "cancel" | "capture-ended" | "finish",
): Promise<void> {
  if (!runtime.sessionId || runtime.finalizing) {
    return;
  }
  const recorder = runtime.recorder;
  if (!recorder || recorder.state === "inactive") {
    if (reason === "capture-ended") {
      await publishError("capture-ended");
    }
    await releaseCapture();
    return;
  }
  runtime.finalizing = true;
  if (runtime.status === "recording") {
    runtime.elapsedMs = elapsedMilliseconds();
  }
  runtime.status = "finalizing";
  await publishState();
  recorder.stop();
  stopTracks(runtime.displayStream);
  stopTracks(runtime.microphoneStream);
}

async function handleMessage(message: OffscreenMessage): Promise<unknown> {
  switch (message.type) {
    case "worker:select-source": {
      return await selectSource(message.sessionId);
    }
    case "worker:microphone": {
      if (message.sessionId === runtime.sessionId) {
        await setMicrophone(message.enabled);
      }
      return { ok: true };
    }
    case "worker:command": {
      if (message.sessionId !== runtime.sessionId) {
        return { ok: false };
      }
      switch (message.action) {
        case "start": {
          await startRecording();
          break;
        }
        case "pause": {
          await pauseRecording();
          break;
        }
        case "resume": {
          await resumeRecording();
          break;
        }
        case "cancel":
        case "finish": {
          await finishRecording(message.action);
          break;
        }
      }
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((value, _sender, sendResponse) => {
  if (!isRuntimeMessage(value) || value.recipient !== "offscreen") {
    return false;
  }
  void handleMessage(value).then(sendResponse);
  return true;
});
