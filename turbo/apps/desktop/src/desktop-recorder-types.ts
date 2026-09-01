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

export type DesktopRecorderSourceKind = "display" | "window";

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
  readonly sourceKind: DesktopRecorderSourceKind;
  readonly systemAudio: boolean;
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
  readonly listSources: () => Promise<readonly DesktopRecorderSource[]>;
  readonly prepare: (
    request: DesktopRecorderPrepareRequest,
  ) => Promise<DesktopRecorderPrepareResult>;
  readonly start: (sessionId: string, outputPath: string) => Promise<void>;
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
