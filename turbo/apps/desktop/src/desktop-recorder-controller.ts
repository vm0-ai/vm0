import {
  UNAVAILABLE_RECORDER_STATE,
  type DesktopRecorderError,
  type DesktopRecorderPrepareRequest,
  type DesktopRecorderRecording,
  type DesktopRecorderSource,
  type DesktopRecorderState,
  type DesktopRecorderStatus,
  type RecorderNativeBackend,
} from "./desktop-recorder-types";

interface DesktopRecorderControllerOptions {
  /** Creates the native capture helper client; called lazily on first use. */
  readonly createBackend: () => RecorderNativeBackend;
  /** Absolute path the next recording is written to. */
  readonly createOutputPath: () => string;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  /** Called for failures on paths that cannot propagate to a caller. */
  readonly logError?: (error: unknown) => void;
}

/**
 * Owns the desktop screen recording session state machine.
 *
 * Kept free of Electron imports so it can be integration-tested by injecting a
 * fake native backend, mirroring `DeveloperToolsController`.
 *
 * The controller does not own a polling timer: `refreshRecordingStatus()` is
 * driven by the caller, the same way `DeveloperToolsController.requestRefresh`
 * is. That keeps the state machine deterministic under test.
 */
export class DesktopRecorderController {
  private readonly createBackend: () => RecorderNativeBackend;
  private readonly createOutputPath: () => string;
  private readonly onChange: () => void;
  private readonly logError: (error: unknown) => void;

  private featureEnabled = false;
  private backend: RecorderNativeBackend | null = null;
  private status: DesktopRecorderStatus = "unavailable";
  private sessionId: string | null = null;
  private elapsedMs = 0;
  private error: DesktopRecorderError | null = null;
  private lastRecording: DesktopRecorderRecording | null = null;

  constructor(options: DesktopRecorderControllerOptions) {
    this.createBackend = options.createBackend;
    this.createOutputPath = options.createOutputPath;
    this.onChange = options.onChange ?? (() => {});
    this.logError = options.logError ?? (() => {});
  }

  getState(): DesktopRecorderState {
    if (!this.featureEnabled) {
      return UNAVAILABLE_RECORDER_STATE;
    }
    return {
      available: true,
      status: this.status,
      sessionId: this.sessionId,
      elapsedMs: this.elapsedMs,
      error: this.error,
      lastRecording: this.lastRecording,
    };
  }

  /**
   * Applies the `desktopScreenRecording` feature switch.
   *
   * Turning it off releases the native helper rather than only hiding the
   * entry point. An in-flight recording is stopped first so the file on disk is
   * finalized instead of truncated; recovering that file is delivery's job.
   */
  setFeatureEnabled(enabled: boolean): void {
    if (this.featureEnabled === enabled) {
      return;
    }
    this.featureEnabled = enabled;
    if (enabled) {
      this.status = "idle";
      this.onChange();
      return;
    }
    void this.releaseAfterDisable();
  }

  async listSources(): Promise<readonly DesktopRecorderSource[]> {
    return await this.requireBackend().listSources();
  }

  /**
   * Prepares and starts a recording of the primary display in one step.
   *
   * The menu bar offers this because it cannot host a source picker; choosing a
   * specific window arrives with the picker UI.
   */
  async startMainDisplayRecording(): Promise<void> {
    const sources = await this.listSources();
    const display = sources.find((source) => {
      return source.kind === "display";
    });
    if (!display) {
      throw new Error("No display is available to record");
    }
    await this.prepare({
      sourceId: display.id,
      sourceKind: "display",
      systemAudio: true,
    });
    await this.start();
  }

  async prepare(request: DesktopRecorderPrepareRequest): Promise<void> {
    const backend = this.requireBackend();
    this.requireStatus("idle");
    this.setStatus("preparing");
    const prepared = await backend.prepare(request);
    if (!this.featureEnabled) {
      return;
    }
    this.sessionId = prepared.sessionId;
    this.error = null;
    this.setStatus("ready");
  }

  async start(): Promise<void> {
    const backend = this.requireBackend();
    const sessionId = this.requireSession();
    this.requireStatus("ready");
    await backend.start(sessionId, this.createOutputPath());
    if (!this.featureEnabled) {
      return;
    }
    this.elapsedMs = 0;
    this.setStatus("recording");
  }

  async stop(): Promise<DesktopRecorderRecording> {
    const backend = this.requireBackend();
    const sessionId = this.requireSession();
    this.requireStatus("recording");
    this.setStatus("finalizing");
    const recording = await backend.stop(sessionId);
    if (this.featureEnabled) {
      this.lastRecording = recording;
      this.sessionId = null;
      this.setStatus("idle");
    }
    return recording;
  }

  /**
   * Pulls the native status while a capture is in flight.
   *
   * The helper protocol has no push channel, so a source disappearing — the
   * window closing, the display being unplugged — only surfaces here.
   */
  async refreshRecordingStatus(): Promise<void> {
    if (this.status !== "recording" || !this.sessionId || !this.backend) {
      return;
    }
    const sessionId = this.sessionId;
    const native = await this.backend.getStatus(sessionId);
    if (this.status !== "recording" || this.sessionId !== sessionId) {
      return;
    }
    if (native.status === "failed") {
      this.failSession(
        native.error ?? {
          code: "capture_failed",
          message: "Screen recording stopped unexpectedly",
        },
      );
      return;
    }
    if (native.elapsedMs !== this.elapsedMs) {
      this.elapsedMs = native.elapsedMs;
      this.onChange();
    }
  }

  private failSession(error: DesktopRecorderError): void {
    this.error = error;
    this.sessionId = null;
    this.elapsedMs = 0;
    this.setStatus("idle");
  }

  private setStatus(status: DesktopRecorderStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.onChange();
  }

  private requireBackend(): RecorderNativeBackend {
    if (!this.featureEnabled) {
      throw new Error("Desktop screen recording is disabled");
    }
    this.backend ??= this.createBackend();
    return this.backend;
  }

  private requireSession(): string {
    if (!this.sessionId) {
      throw new Error("No prepared screen recording session");
    }
    return this.sessionId;
  }

  private requireStatus(expected: DesktopRecorderStatus): void {
    if (this.status !== expected) {
      throw new Error(
        `Screen recording is ${this.status}, expected ${expected}`,
      );
    }
  }

  private async releaseAfterDisable(): Promise<void> {
    const sessionId = this.sessionId;
    const wasRecording = this.status === "recording";

    // Publish unavailability before the asynchronous teardown so the UI stops
    // offering a feature the switch has already withdrawn.
    this.status = "unavailable";
    this.sessionId = null;
    this.elapsedMs = 0;
    this.error = null;
    this.lastRecording = null;
    this.onChange();

    const backend = this.backend;
    this.backend = null;
    if (!backend) {
      return;
    }
    try {
      if (sessionId && wasRecording) {
        await backend.stop(sessionId);
      }
    } catch (error) {
      this.logError(error);
    } finally {
      backend.dispose();
    }
  }
}
