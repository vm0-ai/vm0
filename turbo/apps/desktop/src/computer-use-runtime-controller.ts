import type {
  ComputerUseDriver,
  ComputerUseDriverController,
} from "./computer-use-driver";
import type { ComputerUseNativeShutdownReason } from "./computer-use-native";
import {
  withComputerUseDeadline,
  type ComputerUseLifecycleTimers,
} from "./computer-use-lifecycle-deadline";
import type { DesktopAuthState } from "./desktop-bridge";
import { resolveComputerUseStartupGate } from "./computer-use-startup-gate";
import {
  OFFLINE_COMPUTER_USE_HOST_STATE,
  hasRequiredComputerUsePermissions,
  type ComputerUseHostRuntimeState,
  type ComputerUsePermissionState,
  type DesktopComputerUseDriverState,
} from "./computer-use-types";

const DEFAULT_QUIT_STOP_TIMEOUT_MS = 1_000;

/** The `ComputerUseHostRuntime` surface the controller drives. */
interface ComputerUseRuntimeLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  drainAndStop(): Promise<void>;
  pauseAndDrainCommands(): Promise<() => void>;
  getState(): ComputerUseHostRuntimeState;
}

interface ComputerUseRuntimeControllerOptions {
  readonly prepareNative?: () => Promise<ComputerUsePermissionState>;
  readonly nativeBlockReason?: (driver: ComputerUseDriver) => string | null;
  /**
   * Runtime factory invoked when the startup gate is ready and no runtime
   * exists. The production implementation wires all Electron/session
   * dependencies into a `ComputerUseHostRuntime`.
   */
  readonly createRuntime: () => ComputerUseRuntimeLike;
  readonly refreshPermissions: () => Promise<ComputerUsePermissionState>;
  readonly getAuthState: () => Promise<DesktopAuthState>;
  /** Propagates runtime online/offline transitions to the plugin manager. */
  readonly setHostRuntimeOnline: (online: boolean) => void;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  readonly quitStopTimeoutMs?: number;
  readonly driver?: ComputerUseDriverController;
  readonly transitionTimeoutMs?: number;
  readonly lifecycleTimers?: ComputerUseLifecycleTimers;
  readonly getPluginCapabilities?: () => readonly string[];
  readonly preparePlugins?: () => Promise<void>;
}

/**
 * Owns the Computer Use host runtime lifecycle (start/stop/sign-out/quit),
 * extracted from `main.ts` and kept free of Electron imports so it can be
 * integration-tested by injecting fakes, mirroring the `DesktopAuthSession`
 * dependency-injection shape. Collapses the previously duplicated
 * stop-and-detach paths and the ad-hoc quit flags into one owner.
 */
export class ComputerUseRuntimeController {
  private readonly createRuntime: () => ComputerUseRuntimeLike;
  private readonly refreshPermissions: () => Promise<ComputerUsePermissionState>;
  private readonly getAuthState: () => Promise<DesktopAuthState>;
  private readonly setHostRuntimeOnline: (online: boolean) => void;
  private readonly onChange: () => void;
  private readonly quitStopTimeoutMs: number;

  private runtime: ComputerUseRuntimeLike | null = null;
  private blockedHostState: ComputerUseHostRuntimeState | null = null;
  private manualStopRequested = false;
  private quitStopStarted = false;
  private intent = 0;
  private stopping: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private transitionCount = 0;
  private selectionRevision = 0;
  private lastTransition: {
    driver: ComputerUseDriver;
    promise: Promise<void>;
  } | null = null;
  private requestedDriver: ComputerUseDriver | undefined;
  private runningRequested = false;
  private nativeError: string | null = null;
  private phaseStartedAt = performance.now();
  private transitionTail: Promise<void> = Promise.resolve();
  private readonly driver: ComputerUseDriverController | undefined;
  private readonly transitionTimeoutMs: number;
  private readonly lifecycleTimers: ComputerUseLifecycleTimers | undefined;
  private quitPromise: Promise<void> | null = null;
  private readonly getPluginCapabilities: () => readonly string[];
  private readonly preparePlugins: () => Promise<void>;
  private pluginStartupIntent: number | null = null;

  constructor(private readonly options: ComputerUseRuntimeControllerOptions) {
    this.getPluginCapabilities = options.getPluginCapabilities ?? (() => []);
    this.preparePlugins = options.preparePlugins ?? (async () => {});
    this.lifecycleTimers = options.lifecycleTimers;
    this.driver = options.driver;
    this.requestedDriver = options.driver?.selectedDriver;
    this.transitionTimeoutMs = options.transitionTimeoutMs ?? 30_000;
    this.createRuntime = options.createRuntime;
    this.refreshPermissions = options.refreshPermissions;
    this.getAuthState = options.getAuthState;
    this.setHostRuntimeOnline = options.setHostRuntimeOnline;
    this.onChange = options.onChange ?? (() => {});
    this.quitStopTimeoutMs =
      options.quitStopTimeoutMs ?? DEFAULT_QUIT_STOP_TIMEOUT_MS;
  }

  getHostState(): ComputerUseHostRuntimeState {
    const state =
      this.runtime?.getState() ??
      this.blockedHostState ??
      OFFLINE_COMPUTER_USE_HOST_STATE;
    return this.isTransitioning()
      ? { ...state, driverTransitioning: true }
      : state;
  }

  isRuntimeOnline(): boolean {
    return this.runtime?.getState().status === "online";
  }

  pluginsMayRun(): boolean {
    return this.isRuntimeOnline() || this.pluginStartupIntent === this.intent;
  }

  private nativeBlockReason(): string | null {
    return this.requestedDriver
      ? (this.options.nativeBlockReason?.(this.requestedDriver) ?? null)
      : null;
  }

  getDriverState(): Pick<
    DesktopComputerUseDriverState,
    | "actual"
    | "phase"
    | "lifecycleElapsedMs"
    | "cleanupPending"
    | "error"
    | "canRetry"
  > {
    const state = this.driver?.getState();
    const blocked = this.nativeBlockReason();
    const error = this.nativeError ?? state?.error ?? blocked;
    const phase =
      this.nativeError || state?.error
        ? "error"
        : this.transitionCount > 0
          ? "switching"
          : state?.cleanupPending
            ? "retiring"
            : this.starting
              ? "starting"
              : blocked
                ? "blocked"
                : state?.ready
                  ? "ready"
                  : "stopped";
    return {
      actual: state?.actual ?? null,
      phase,
      lifecycleElapsedMs: Math.min(
        120_000,
        Math.max(0, Math.round(performance.now() - this.phaseStartedAt)),
      ),
      cleanupPending: state?.cleanupPending ?? false,
      error,
      canRetry:
        !this.quitStopStarted &&
        !this.isTransitioning() &&
        !blocked &&
        !state?.ready,
    };
  }

  /** Availability changes use the same replacement queue, never a fresh owner. */
  async refreshDriverAuthorization(): Promise<void> {
    if (!this.requestedDriver?.getAuthorization || this.quitStopStarted) return;
    if (this.nativeBlockReason()) {
      this.supersede();
      this.driver?.withdrawAdmission();
      void this.driver?.forceRetire().catch(() => {});
      await this.transitionDriver(this.requestedDriver);
    } else if (
      this.runningRequested &&
      !this.manualStopRequested &&
      !this.nativeError &&
      !this.driver?.getState().error
    ) {
      if (this.runtime) await this.transitionDriver(this.requestedDriver);
      else await this.start();
    }
    this.onChange();
  }

  /**
   * Starts the runtime when permissions and auth pass the startup gate;
   * otherwise stops any existing runtime and records the blocked host state.
   * Non-user-initiated starts are suppressed after a manual stop.
   */
  async start(
    options: {
      readonly userInitiated?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (
      this.quitStopStarted ||
      ((this.nativeError !== null || this.driver?.getState().error) &&
        options.userInitiated !== true) ||
      (this.manualStopRequested && options.userInitiated !== true)
    )
      return;
    options.signal?.throwIfAborted();
    this.runningRequested = true;
    if (options.userInitiated) {
      if (this.driver?.getState().error) {
        this.stopping = Promise.all([
          this.stopping,
          this.driver.forceRetire(),
        ]).then(() => {});
      }
      this.nativeError = null;
      this.driver?.resetFailure();
    }
    this.manualStopRequested = false;
    if (this.starting) return this.starting;
    const intent = this.intent;
    const abort = () => {
      if (intent !== this.intent) return;
      this.supersede();
      this.detachRuntime();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const selection = this.selectionRevision;
    const start = this.startRuntime(intent, selection, this.transitionTail);
    this.starting = start;
    this.phaseStartedAt = performance.now();
    try {
      await start;
    } catch (error) {
      if (intent === this.intent && selection === this.selectionRevision)
        this.nativeError =
          "Driver startup failed. Retry after cleanup, or use Okou.";
      throw error;
    } finally {
      if (this.pluginStartupIntent === intent) {
        this.pluginStartupIntent = null;
        this.setHostRuntimeOnline(this.isRuntimeOnline());
      }
      options.signal?.removeEventListener("abort", abort);
      if (this.starting === start) this.starting = null;
      this.onChange();
    }
  }

  private async startRuntime(
    intent: number,
    selection: number,
    transitions: Promise<void>,
  ): Promise<void> {
    await withComputerUseDeadline(
      this.stopping,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    await withComputerUseDeadline(
      transitions,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    if (intent !== this.intent || selection !== this.selectionRevision) return;
    if (
      this.driver &&
      this.requestedDriver &&
      this.driver.selectedDriver !== this.requestedDriver
    ) {
      await withComputerUseDeadline(
        this.driver.retire(),
        this.transitionTimeoutMs,
        this.lifecycleTimers,
      );
      if (intent !== this.intent || selection !== this.selectionRevision)
        return;
      this.driver.select(this.requestedDriver);
    }
    const authState = await this.getAuthState();
    if (intent !== this.intent || selection !== this.selectionRevision) return;
    const permissions = await this.prepareStartupPermissions(
      authState,
      intent,
      selection,
    );
    if (
      !permissions ||
      intent !== this.intent ||
      selection !== this.selectionRevision
    )
      return;
    const startupGate = resolveComputerUseStartupGate({
      authState,
      permissions,
      pluginCapabilities: this.getPluginCapabilities(),
    });
    if (startupGate.status !== "ready") {
      await this.detachRuntime();
      if (intent !== this.intent || selection !== this.selectionRevision)
        return;
      if (startupGate.status === "blocked") {
        this.blockedHostState = startupGate.host;
        this.onChange();
      }
      return;
    }
    this.blockedHostState = null;
    if (
      hasRequiredComputerUsePermissions(permissions) &&
      !this.nativeBlockReason()
    )
      this.driver?.activate();
    const runtime = (this.runtime ??= this.createRuntime());
    await runtime.start();
    if (intent !== this.intent || selection !== this.selectionRevision) return;
    this.setHostRuntimeOnline(runtime.getState().status === "online");
  }

  private async prepareStartupPermissions(
    authState: DesktopAuthState,
    intent: number,
    selection: number,
  ): Promise<ComputerUsePermissionState | null> {
    this.driver?.resumePermissions();
    let permissions = await withComputerUseDeadline(
      this.refreshPermissions(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    ).catch(() => {
      void this.driver?.forceRetire().catch(() => {});
      return { accessibility: false, screenRecording: false };
    });
    if (intent !== this.intent || selection !== this.selectionRevision)
      return null;
    if (this.nativeBlockReason()) {
      permissions = { accessibility: false, screenRecording: false };
    } else if (
      authState.status === "signed_in" &&
      authState.organization &&
      hasRequiredComputerUsePermissions(permissions) &&
      this.options.prepareNative
    ) {
      try {
        permissions = await withComputerUseDeadline(
          this.options.prepareNative(),
          this.transitionTimeoutMs,
          this.lifecycleTimers,
        );
      } catch {
        if (intent === this.intent && selection === this.selectionRevision)
          this.nativeError =
            "Driver startup failed. Retry after cleanup, or use Okou.";
        void this.driver?.forceRetire().catch(() => {});
        permissions = { accessibility: false, screenRecording: false };
      }
      if (intent !== this.intent || selection !== this.selectionRevision)
        return null;
      if (!hasRequiredComputerUsePermissions(permissions) && !this.nativeError)
        this.nativeError =
          "Driver permissions are unavailable. Check host permissions and retry.";
    }
    if (
      !hasRequiredComputerUsePermissions(permissions) &&
      this.requestedDriver?.id === "cua" &&
      !this.nativeBlockReason() &&
      authState.status === "signed_in"
    ) {
      this.nativeError ??=
        "Driver permissions are unavailable. Check host permissions and retry.";
    }
    if (
      !hasRequiredComputerUsePermissions(permissions) &&
      authState.status === "signed_in" &&
      authState.organization
    ) {
      this.pluginStartupIntent = intent;
      await withComputerUseDeadline(
        this.preparePlugins(),
        this.transitionTimeoutMs,
        this.lifecycleTimers,
      );
      if (intent !== this.intent || selection !== this.selectionRevision)
        return null;
    }
    return permissions;
  }

  /** Serialized native replacement; it never changes host/plugin online state on success. */
  transitionDriver(driver: ComputerUseDriver): Promise<void> {
    if (this.lastTransition?.driver === driver)
      return this.lastTransition.promise;
    if (!this.driver || this.quitStopStarted) {
      return Promise.reject(
        new Error("Computer Use driver transitions are unavailable"),
      );
    }
    this.requestedDriver = driver;
    const selection = ++this.selectionRevision;
    const intent = this.intent;
    const pendingStart = this.starting;
    const initialRuntime = this.runtime;
    // Close admission before awaiting any preceding transition.
    const initialDrain = initialRuntime?.pauseAndDrainCommands();
    this.driver.pausePermissions();
    let expired = false;
    const checkIntent = () => {
      if (
        expired ||
        intent !== this.intent ||
        selection !== this.selectionRevision
      )
        throw new Error("Computer Use driver transition was superseded");
    };
    const previous = this.transitionTail;
    const work = (async () => {
      await previous;
      // Startup reports its own bounded failure; replacement still has to
      // retire that owner and install the requested lane for explicit recovery.
      await pendingStart?.catch(() => {});
      // Only the latest accepted selection activates. Earlier callers still
      // retain their work/cleanup, but do not publish obsolete readiness.
      if (selection !== this.selectionRevision && intent === this.intent)
        return;
      checkIntent();
      const runtime = this.runtime;
      this.driver?.pausePermissions();
      const resume = await (runtime === initialRuntime
        ? initialDrain
        : runtime?.pauseAndDrainCommands());
      checkIntent();
      await this.driver?.retire();
      checkIntent();
      this.driver?.select(driver);
      if (
        !runtime &&
        pendingStart &&
        this.runningRequested &&
        !this.manualStopRequested &&
        !this.nativeError &&
        !this.driver?.getState().error
      ) {
        // Preserve the already-running Start intent, while only its latest
        // selection may register a host. Do not await our own transition tail.
        await this.startRuntime(intent, selection, Promise.resolve());
        return;
      }
      if (runtime && !this.manualStopRequested)
        await this.resumeSelectedDriver(resume, checkIntent);
    })();
    const transition = withComputerUseDeadline(
      work,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    ).catch((error: unknown) => {
      expired = true;
      this.handleDriverTransitionFailure(error, intent, selection);
    });
    this.transitionCount++;
    this.phaseStartedAt = performance.now();
    this.lastTransition = { driver, promise: transition };
    // The caller-facing deadline is not proof the underlying work retired.
    this.transitionTail = work.then(
      () => {},
      () => {},
    );
    void this.transitionTail.then(() => {
      this.transitionCount--;
      this.onChange();
    });
    const finish = () => {
      if (this.lastTransition?.promise === transition)
        this.lastTransition = null;
      this.onChange();
    };
    void transition.then(finish, finish);
    this.onChange();
    return transition;
  }

  private handleDriverTransitionFailure(
    error: unknown,
    intent: number,
    selection: number,
  ): void {
    // A failure withdraws the host rather than advertising empty legacy capabilities.
    if (intent === this.intent && selection === this.selectionRevision) {
      this.nativeError =
        "Driver transition failed. Retry after cleanup, or use Okou.";
      void this.driver?.forceRetire().catch(() => {});
      if (this.getPluginCapabilities().length > 0 && this.runtime) {
        // The rejected transition keeps its native owner retired. Existing
        // host authorization, heartbeat and plugin processes remain intact.
        void this.runtime.pauseAndDrainCommands().then((resume) => resume());
        throw error;
      }
      this.manualStopRequested = true;
      this.supersede();
      this.detachRuntime();
      this.blockedHostState = {
        ...OFFLINE_COMPUTER_USE_HOST_STATE,
        status: "error",
        lastError: this.nativeError,
      };
    }
    if (intent === this.intent && selection !== this.selectionRevision) return;
    throw error;
  }

  private async resumeSelectedDriver(
    resume: (() => void) | undefined,
    checkIntent: () => void,
  ): Promise<void> {
    if (
      this.nativeError ||
      this.driver?.getState().error ||
      this.nativeBlockReason()
    ) {
      if (this.getPluginCapabilities().length > 0) resume?.();
      else await this.detachRuntime();
      return;
    }
    const auth = await this.getAuthState();
    checkIntent();
    if (auth.status !== "signed_in" || !auth.organization) {
      await this.detachRuntime();
      return;
    }
    let permissions = await this.refreshPermissions();
    checkIntent();
    if (
      hasRequiredComputerUsePermissions(permissions) &&
      this.options.prepareNative
    )
      permissions = await this.options.prepareNative();
    checkIntent();
    if (!hasRequiredComputerUsePermissions(permissions)) {
      this.nativeError =
        "Driver permissions are unavailable. Check host permissions and retry.";
      if (this.getPluginCapabilities().length === 0)
        throw new Error("Computer Use permissions are unavailable");
    }
    if (hasRequiredComputerUsePermissions(permissions)) this.driver?.activate();
    resume?.();
  }

  isTransitioning(): boolean {
    return (
      this.transitionCount > 0 ||
      this.starting !== null ||
      (this.driver?.cleanupPending ?? false)
    );
  }

  /** User-initiated stop; suppresses auto-restarts until the next manual start. */
  async stop(): Promise<void> {
    this.runningRequested = false;
    this.manualStopRequested = true;
    this.supersede();
    await withComputerUseDeadline(
      this.detachRuntime(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
  }

  /** Stops admitting work, lets the active command finish, then stops. */
  async drainAndStop(): Promise<void> {
    this.runningRequested = false;
    this.manualStopRequested = true;
    this.supersede();
    await this.runtime?.drainAndStop();
    await this.detachRuntime();
  }

  /**
   * Detaches and stops the runtime when the auth session changes (sign-out or
   * a completed sign-in), so a subsequent start builds a fresh runtime.
   */
  async stopForAuthChange(): Promise<void> {
    this.supersede();
    await withComputerUseDeadline(
      this.detachRuntime(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
  }

  /** Auth completion preserves manual Stop intent and cannot revive superseded work. */
  async startForAuthChange(signal: AbortSignal): Promise<void> {
    this.supersede();
    const intent = this.intent;
    await withComputerUseDeadline(
      this.detachRuntime(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    signal.throwIfAborted();
    if (intent === this.intent) await this.start({ signal });
  }

  /** Clears a stale blocked host state once required permissions are missing. */
  clearBlockedHostState(): void {
    this.blockedHostState = null;
  }

  /** True when quitting must first stop a live runtime. */
  quitStopRequired(): boolean {
    return this.runtime !== null && !this.quitStopStarted;
  }

  /**
   * Stops the runtime for app quit, bounded by the quit-stop timeout.
   * Idempotent: concurrent quit paths (before-quit, quit-and-install) share
   * one stop attempt.
   */
  stopForQuit(
    reason: ComputerUseNativeShutdownReason = "app_quit",
  ): Promise<void> {
    if (this.quitPromise) return this.quitPromise;
    this.quitStopStarted = true;
    this.supersede();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) this.setHostRuntimeOnline(false);
    const stop = runtime?.stop() ?? Promise.resolve();
    // Native disposal has its own process shutdown bound. Do not gate it on HTTP stop.
    const retirement = this.driver?.retire(reason) ?? Promise.resolve();
    this.quitPromise = Promise.all([
      withComputerUseDeadline(
        stop,
        this.quitStopTimeoutMs,
        this.lifecycleTimers,
      ).catch(() => {}),
      retirement,
    ]).then(() => {});
    return this.quitPromise;
  }

  private supersede(): void {
    this.intent++;
    this.lastTransition = null;
    this.phaseStartedAt = performance.now();
    this.starting = null;
    this.driver?.pausePermissions();
  }

  private detachRuntime(): Promise<void> {
    const intent = this.intent;
    const runtime = this.runtime;
    this.runtime = null;
    this.blockedHostState = null;
    this.setHostRuntimeOnline(false);
    const stop = runtime?.stop() ?? Promise.resolve();
    const retirement = this.driver?.forceRetire() ?? Promise.resolve();
    const cleanup = Promise.all([this.stopping, stop, retirement]).then(() => {
      if (intent === this.intent && !this.quitStopStarted)
        this.driver?.resumePermissions();
    });
    this.stopping = cleanup;
    void cleanup.then(this.onChange, this.onChange);
    return cleanup;
  }
}
