/**
 * Shared types for desktop screen recording.
 *
 * The renderer only ever sees `DesktopRecorderState`; every field here is
 * structured-clone safe so it can cross the IPC boundary unchanged.
 */

export type DesktopRecorderStatus =
  | "delivering"
  | "finalizing"
  | "idle"
  | "paused"
  | "preparing"
  | "ready"
  | "recording"
  | "unavailable";

export type DesktopRecorderErrorCode =
  | "capture_failed"
  | "delivery_failed"
  | "helper_unavailable"
  | "permission_denied"
  | "signed_out"
  | "source_lost";

export interface DesktopRecorderError {
  readonly code: DesktopRecorderErrorCode;
  readonly message: string;
}

/** What `listSources` can enumerate. An area is a crop, not a listable source. */
export type DesktopRecorderSourceKind = "display" | "window";

/** What a capture can be aimed at. */
export type DesktopRecorderCaptureKind = DesktopRecorderSourceKind | "area";

/** A selected region in global screen points, top-left origin. */
export interface DesktopRecorderArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The two audio tracks a capture can carry, as the bar has them set. */
export interface DesktopRecorderAudioChoice {
  readonly systemAudio: boolean;
  readonly microphone: boolean;
}

/**
 * What the bar asks to capture.
 *
 * Only a window names its source; a whole-display capture is aimed at the
 * screen the bar itself is on, which only the main process knows. An area is
 * not here at all: its selection ends in the overlay that drew it, so that
 * request is assembled in the main process from the display the drag happened
 * on.
 */
export type DesktopRecorderCaptureRequest = DesktopRecorderAudioChoice &
  (
    | { readonly sourceKind: "display" }
    | { readonly sourceKind: "window"; readonly sourceId: string }
  );

/**
 * A region drawn on one display, in that display's own coordinates.
 *
 * The overlay reports which display it covers, because a drag on a secondary
 * screen means nothing until it is rebased onto that screen's origin.
 */
export interface DesktopRecorderAreaSelection {
  readonly displayId: number;
  readonly area: DesktopRecorderArea;
}

/** A window as it currently looks, captured for the picker. */
export interface DesktopRecorderWindowPreview {
  readonly id: string;
  /** A PNG data URL. */
  readonly previewDataUrl: string;
}

/** A window the picker offers, with the preview the user recognises it by. */
export interface DesktopRecorderWindowOption {
  readonly id: string;
  readonly title: string;
  readonly appName: string;
  /** A PNG data URL of the window as it looks right now. */
  readonly previewDataUrl: string;
}

/** What the picker hands back when the user chooses a window. */
export interface DesktopRecorderWindowChoice {
  readonly sourceId: string;
  readonly title: string;
}

/** What this system can record, known without reading the screen. */
export interface DesktopRecorderCapabilities {
  /** ScreenCaptureKit only reaches the microphone on macOS 15 and later. */
  readonly supportsMicrophone: boolean;
}

export interface DesktopRecorderSource {
  readonly id: string;
  readonly kind: DesktopRecorderSourceKind;
  readonly title: string;
  readonly appName?: string;
  readonly bundleId?: string;
}

/**
 * Where the captured region sits in global screen points, and how many pixels
 * each point becomes. Click coordinates are mapped through this, so it is
 * reported by the helper rather than derived on the JavaScript side.
 */
export interface DesktopRecorderCaptureGeometry {
  readonly originX: number;
  readonly originY: number;
  readonly widthPoints: number;
  readonly heightPoints: number;
  readonly scale: number;
}

export interface DesktopRecorderRecording {
  readonly videoPath: string;
  /**
   * Sidecar JSON holding clicks and pointer movement inside the captured
   * region, timestamped against the same clock as the video frames.
   */
  readonly clickTrackPath: string;
  readonly durationMs: number;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  /**
   * Set when the capture broke before it was stopped. The file still holds
   * whatever was written up to that point, so it is kept for a deliberate
   * retry, but it must not be delivered as though the recording finished.
   */
  readonly failure?: DesktopRecorderError;
}

export interface DesktopRecorderState {
  readonly available: boolean;
  readonly status: DesktopRecorderStatus;
  readonly sessionId: string | null;
  readonly elapsedMs: number;
  readonly error: DesktopRecorderError | null;
  readonly lastRecording: DesktopRecorderRecording | null;
}

export interface DesktopRecorderPrepareRequest {
  readonly sourceId: string;
  readonly sourceKind: DesktopRecorderCaptureKind;
  readonly systemAudio: boolean;
  /** Narration, on its own track. Needs macOS 15 or later. */
  readonly microphone: boolean;
  /**
   * Required when `sourceKind` is `"area"`, and `sourceId` then names the
   * display the region was drawn on. ScreenCaptureKit has no region filter, so
   * the display is captured and this crops it.
   */
  readonly area?: DesktopRecorderArea;
}

export interface DesktopRecorderPrepareResult {
  readonly sessionId: string;
  readonly geometry: DesktopRecorderCaptureGeometry;
  readonly width: number;
  readonly height: number;
}

export interface DesktopRecorderNativeStatus {
  readonly status: "failed" | "paused" | "ready" | "recording" | "stopped";
  readonly elapsedMs: number;
  readonly error?: DesktopRecorderError;
}

/**
 * The native capture helper, as seen from the Electron main process.
 *
 * Kept as an interface so the session controller can be integration-tested
 * without a macOS helper binary, mirroring `ComputerUseNativeBackend`.
 */
export interface RecorderNativeBackend {
  readonly dispose: () => void;
  readonly getCapabilities: () => Promise<DesktopRecorderCapabilities>;
  /**
   * Asks the system for the screen recording grant and reports the answer.
   *
   * macOS only shows its prompt the first time; once answered it returns the
   * standing answer without asking again, which is why this is safe to call
   * before each capture and is the only path that can raise the prompt at all.
   */
  readonly requestScreenRecordingPermission: () => Promise<boolean>;
  /**
   * The windows and displays on screen. Reading this asks ScreenCaptureKit for
   * the screen recording grant, so it is only called once the user is choosing
   * what to record.
   */
  readonly listSources: () => Promise<readonly DesktopRecorderSource[]>;
  /** One image per window, for the picker to show them by. */
  readonly listWindowPreviews: () => Promise<
    readonly DesktopRecorderWindowPreview[]
  >;
  readonly prepare: (
    request: DesktopRecorderPrepareRequest,
  ) => Promise<DesktopRecorderPrepareResult>;
  readonly start: (sessionId: string, outputPath: string) => Promise<void>;
  readonly pause: (sessionId: string) => Promise<void>;
  readonly resume: (sessionId: string) => Promise<void>;
  /** Ends the capture and deletes what was written. */
  readonly discard: (sessionId: string) => Promise<void>;
  readonly stop: (sessionId: string) => Promise<DesktopRecorderRecording>;
  readonly getStatus: (
    sessionId: string,
  ) => Promise<DesktopRecorderNativeStatus>;
}

/**
 * Stops an in-flight recording from any application.
 *
 * Registered only while recording, so the shortcut is not held hostage the rest
 * of the time. It exists because the recording controls deliberately live in
 * the menu bar rather than in an on-screen overlay, which would otherwise be
 * captured into the user's own video.
 */
export const STOP_SCREEN_RECORDING_ACCELERATOR = "Control+Shift+R";
export const STOP_SCREEN_RECORDING_ACCELERATOR_LABEL = "⌃⇧R";

export const UNAVAILABLE_RECORDER_STATE: DesktopRecorderState = Object.freeze({
  available: false,
  status: "unavailable",
  sessionId: null,
  elapsedMs: 0,
  error: null,
  lastRecording: null,
});
