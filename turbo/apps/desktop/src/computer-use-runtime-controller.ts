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
  private readonly transitions = new Map<ComputerUseDriver, Promise<void>>();
  private transitionTail: Promise<void> = Promise.resolve();
  private readonly driver: ComputerUseDriverController | undefined;
  private readonly transitionTimeoutMs: number;
  private readonly lifecycleTimers: ComputerUseLifecycleTimers | undefined;
  private quitPromise: Promise<void> | null = null;

  constructor(options: ComputerUseRuntimeControllerOptions) {
    this.lifecycleTimers = options.lifecycleTimers;
    this.driver = options.driver;
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
      (this.manualStopRequested && options.userInitiated !== true)
    )
      return;
    options.signal?.throwIfAborted();
    this.manualStopRequested = false;
    if (this.starting) return this.starting;
    const intent = this.intent;
    const abort = () => {
      if (intent !== this.intent) return;
      this.supersede();
      this.detachRuntime();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const start = this.startRuntime(intent, this.transitionTail);
    this.starting = start;
    try {
      await start;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      if (this.starting === start) this.starting = null;
    }
  }

  private async startRuntime(
    intent: number,
    transitions: Promise<void>,
  ): Promise<void> {
    await withComputerUseDeadline(
      this.stopping,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    await transitions;
    if (intent !== this.intent) return;
    this.driver?.resumePermissions();
    const permissions = await this.refreshPermissions();
    if (intent !== this.intent) return;
    if (!hasRequiredComputerUsePermissions(permissions)) {
      await this.detachRuntime();
      return;
    }
    const authState = await this.getAuthState();
    if (intent !== this.intent) return;
    const startupGate = resolveComputerUseStartupGate({
      authState,
      permissions,
    });
    if (startupGate.status !== "ready") {
      await this.detachRuntime();
      if (intent !== this.intent) return;
      if (startupGate.status === "blocked") {
        this.blockedHostState = startupGate.host;
        this.onChange();
      }
      return;
    }
    this.blockedHostState = null;
    this.driver?.activate();
    const runtime = (this.runtime ??= this.createRuntime());
    await runtime.start();
    if (intent !== this.intent) return;
    this.setHostRuntimeOnline(runtime.getState().status === "online");
  }

  /** Serialized native replacement; it never changes host/plugin online state on success. */
  transitionDriver(driver: ComputerUseDriver): Promise<void> {
    const existing = this.transitions.get(driver);
    if (existing) return existing;
    if (!this.driver || this.quitStopStarted) {
      return Promise.reject(
        new Error("Computer Use driver transitions are unavailable"),
      );
    }
    const intent = this.intent;
    const pendingStart = this.starting;
    const initialRuntime = this.runtime;
    // Close admission before awaiting any preceding transition.
    const initialDrain = initialRuntime?.pauseAndDrainCommands();
    this.driver.pausePermissions();
    let expired = false;
    const checkIntent = () => {
      if (expired || intent !== this.intent)
        throw new Error("Computer Use driver transition was superseded");
    };
    const work = (async () => {
      await this.transitionTail;
      await pendingStart;
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
      if (runtime && !this.manualStopRequested) {
        const permissions = await this.refreshPermissions();
        checkIntent();
        if (!hasRequiredComputerUsePermissions(permissions))
          throw new Error("Computer Use permissions are unavailable");
        this.driver?.activate();
        resume?.();
      }
    })();
    const transition = withComputerUseDeadline(
      work,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    ).catch((error: unknown) => {
      expired = true;
      // A failure withdraws the host rather than advertising empty legacy capabilities.
      if (intent === this.intent) {
        this.manualStopRequested = true;
        this.supersede();
        this.detachRuntime();
        this.blockedHostState = {
          ...OFFLINE_COMPUTER_USE_HOST_STATE,
          status: "error",
          lastError: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    });
    this.transitions.set(driver, transition);
    this.transitionTail = transition.then(
      () => {},
      () => {},
    );
    void this.transitionTail.then(() => {
      this.transitions.delete(driver);
      this.onChange();
    });
    this.onChange();
    return transition;
  }

  isTransitioning(): boolean {
    return this.transitions.size > 0;
  }

  /** User-initiated stop; suppresses auto-restarts until the next manual start. */
  async stop(): Promise<void> {
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
    const retirement = this.driver?.retire() ?? Promise.resolve();
    const cleanup = Promise.all([this.stopping, stop, retirement]).then(() => {
      if (intent === this.intent && !this.quitStopStarted)
        this.driver?.resumePermissions();
    });
    this.stopping = cleanup;
    void cleanup.then(this.onChange, this.onChange);
    return cleanup;
  }
}
