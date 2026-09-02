import type { DeliveredRecording } from "./desktop-recorder-delivery";
import {
  UNAVAILABLE_RECORDER_STATE,
  type DesktopRecorderError,
  type DesktopRecorderPrepareRequest,
  type DesktopRecorderRecording,
  type DesktopRecorderCapabilities,
  type DesktopRecorderSource,
  type DesktopRecorderWindowPreview,
  type DesktopRecorderState,
  type DesktopRecorderStatus,
  type RecorderNativeBackend,
} from "./desktop-recorder-types";

interface DesktopRecorderControllerOptions {
  /** Creates the native capture helper client; called lazily on first use. */
  readonly createBackend: () => RecorderNativeBackend;
  /** Absolute path the next recording is written to. */
  readonly createOutputPath: () => string;
  /**
   * Whether delivery back to Okou is currently possible. Checked before the
   * capture starts rather than after, so a signed-out user is told before
   * spending minutes recording something that cannot be handed over.
   */
  readonly canDeliver: () => Promise<boolean>;
  /** Uploads the finished recording and returns the review link to open. */
  readonly deliver: (
    recording: DesktopRecorderRecording,
  ) => Promise<DeliveredRecording>;
  /** Opens the review link in the user's browser. */
  readonly openReview: (reviewUrl: string) => void;
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
  private readonly canDeliver: () => Promise<boolean>;
  private readonly deliver: (
    recording: DesktopRecorderRecording,
  ) => Promise<DeliveredRecording>;
  private readonly openReview: (reviewUrl: string) => void;
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
    this.canDeliver = options.canDeliver;
    this.deliver = options.deliver;
    this.openReview = options.openReview;
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
   * Applies the effective native recording availability resolved from the
   * `introVideo` and `desktopScreenRecording` feature switches.
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

  async getCapabilities(): Promise<DesktopRecorderCapabilities> {
    return await this.requireBackend().getCapabilities();
  }

  /**
   * Makes sure the system has been asked for the recording grant.
   *
   * Called before anything that reads the screen, because the helper refuses
   * to touch ScreenCaptureKit without the grant and the prompt is the only way
   * a first-time user can give it.
   */
  async ensureScreenRecordingPermission(): Promise<void> {
    const granted =
      await this.requireBackend().requestScreenRecordingPermission();
    if (!granted) {
      throw new Error(
        "Okou needs Screen Recording permission in System Settings",
      );
    }
  }

  async listSources(): Promise<readonly DesktopRecorderSource[]> {
    return await this.requireBackend().listSources();
  }

  async listWindowPreviews(): Promise<readonly DesktopRecorderWindowPreview[]> {
    return await this.requireBackend().listWindowPreviews();
  }

  async prepare(request: DesktopRecorderPrepareRequest): Promise<void> {
    const backend = this.requireBackend();
    this.requireStatus("idle");
    if (!(await this.canDeliver())) {
      this.error = {
        code: "signed_out",
        message:
          "Sign in to Okou before recording so the result can be delivered",
      };
      this.onChange();
      throw new Error("Cannot record while signed out of Okou");
    }
    this.setStatus("preparing");
    // A rejected prepare — a denied Screen Recording permission is the common
    // one — must return the machine to `idle`, otherwise every later attempt
    // fails `requireStatus("idle")` for the lifetime of the process.
    const prepared = await this.restoreStatusOnFailure("idle", async () => {
      return await backend.prepare(request);
    });
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

  async pause(): Promise<void> {
    const backend = this.requireBackend();
    const sessionId = this.requireSession();
    this.requireStatus("recording");
    await backend.pause(sessionId);
    this.setStatus("paused");
  }

  async resume(): Promise<void> {
    const backend = this.requireBackend();
    const sessionId = this.requireSession();
    this.requireStatus("paused");
    await backend.resume(sessionId);
    this.setStatus("recording");
  }

  /**
   * Ends the capture and throws the recording away.
   *
   * Nothing is kept as `lastRecording`, so a discarded recording cannot be
   * delivered later by a retry.
   */
  async discard(): Promise<void> {
    const backend = this.requireBackend();
    const sessionId = this.requireSession();
    if (this.status !== "recording" && this.status !== "paused") {
      throw new Error(`Screen recording is ${this.status}, expected recording`);
    }
    await backend.discard(sessionId);
    this.sessionId = null;
    this.elapsedMs = 0;
    this.error = null;
    this.lastRecording = null;
    this.setStatus("idle");
  }

  async stop(): Promise<DesktopRecorderRecording> {
    const backend = this.requireBackend();
    const sessionId = this.requireSession();
    const resumeStatus = this.status;
    if (resumeStatus !== "recording" && resumeStatus !== "paused") {
      throw new Error(`Screen recording is ${this.status}, expected recording`);
    }
    this.setStatus("finalizing");
    // A rejected stop leaves the session in the caller's hands: go back to
    // `recording` so the stop can be retried, rather than stranding the machine
    // in `finalizing` where neither stop nor prepare is accepted again. The
    // reason is recorded as well as rethrown: the window that asked is often
    // gone by the time the answer arrives, and a rejection nobody receives
    // left the controls vanished with nothing anywhere saying why.
    let recording: DesktopRecorderRecording;
    try {
      recording = await backend.stop(sessionId);
    } catch (error) {
      if (this.featureEnabled) {
        this.error = {
          code: "capture_failed",
          message: error instanceof Error ? error.message : String(error),
        };
        this.setStatus(resumeStatus);
        this.onChange();
      }
      throw error;
    }
    if (!this.featureEnabled) {
      return recording;
    }
    this.lastRecording = recording;
    this.sessionId = null;
    // A capture whose writer broke still hands back the file it managed to
    // write, but shipping it as the finished recording is how a two-second
    // movie reached the editor. Keep it, say why, and leave delivery to a
    // deliberate retry.
    if (recording.failure) {
      this.failSession(recording.failure);
      return recording;
    }
    await this.runDelivery(recording);
    return recording;
  }

  /**
   * Uploads the last recording again after a failed delivery.
   *
   * The capture itself already succeeded and the files are still on disk, so a
   * network failure must not cost the user the recording.
   */
  async retryDelivery(): Promise<void> {
    const recording = this.lastRecording;
    if (!recording) {
      throw new Error("There is no recording to deliver");
    }
    this.requireStatus("idle");
    await this.runDelivery(recording);
  }

  /**
   * Delivery failures are captured into state rather than propagated: the
   * recording on disk is intact and retryable, so losing the upload is not a
   * reason to fail the stop the user just asked for.
   */
  private async runDelivery(
    recording: DesktopRecorderRecording,
  ): Promise<void> {
    this.setStatus("delivering");
    try {
      const delivered = await this.deliver(recording);
      this.error = null;
      this.setStatus("idle");
      this.openReview(delivered.reviewUrl);
    } catch (error) {
      this.error = {
        code: "delivery_failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.setStatus("idle");
    }
  }

  /**
   * Pulls the native status while a capture is in flight.
   *
   * The helper protocol has no push channel, so a source disappearing — the
   * window closing, the display being unplugged — only surfaces here.
   */
  async refreshRecordingStatus(): Promise<void> {
    // A paused capture is still open, but its own status is what the poll would
    // be reading, so leave it alone until it resumes.
    if (this.status !== "recording" || !this.sessionId || !this.backend) {
      return;
    }
    const sessionId = this.sessionId;
    const native = await this.backend.getStatus(sessionId);
    if (this.status !== "recording" || this.sessionId !== sessionId) {
      return;
    }
    if (native.status === "stopped") {
      // Ending the share from the system indicator is an ordinary finish, so it
      // takes the same path an explicit stop would: finalize, then deliver.
      await this.collectAfterExternalStop(sessionId, null);
      return;
    }
    if (native.status === "failed") {
      await this.collectAfterExternalStop(
        sessionId,
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

  /**
   * Finalizes a capture that ended without `stop` being called.
   *
   * The frames already written are the recording the user made, so the file and
   * its click track are collected either way. A capture that ended cleanly is
   * then delivered; one that broke is kept with its reason so the tray can offer
   * a retry, rather than silently shipping a recording that failed.
   */
  private async collectAfterExternalStop(
    sessionId: string,
    failure: DesktopRecorderError | null,
  ): Promise<void> {
    const backend = this.backend;
    if (!backend) {
      return;
    }
    this.setStatus("finalizing");

    let recording: DesktopRecorderRecording;
    try {
      recording = await backend.stop(sessionId);
    } catch (error) {
      this.logError(error);
      this.failSession(
        failure ?? {
          code: "capture_failed",
          message: "Screen recording could not be finalized",
        },
      );
      return;
    }

    this.lastRecording = recording;
    this.sessionId = null;
    this.elapsedMs = 0;
    const reason = failure ?? recording.failure;
    if (reason) {
      this.failSession(reason);
      return;
    }
    await this.runDelivery(recording);
  }

  /**
   * Runs a native call that owns a transient status, putting the status back
   * when it rejects so the machine stays usable. The rejection itself is
   * rethrown: the caller made the request and is the one that can react to it.
   */
  private async restoreStatusOnFailure<T>(
    restored: DesktopRecorderStatus,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (this.featureEnabled) {
        this.setStatus(restored);
      }
      throw error;
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
