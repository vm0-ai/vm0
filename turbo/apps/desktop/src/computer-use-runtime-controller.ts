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

  constructor(options: ComputerUseRuntimeControllerOptions) {
    this.createRuntime = options.createRuntime;
    this.refreshPermissions = options.refreshPermissions;
    this.getAuthState = options.getAuthState;
    this.setHostRuntimeOnline = options.setHostRuntimeOnline;
    this.onChange = options.onChange ?? (() => {});
    this.quitStopTimeoutMs =
      options.quitStopTimeoutMs ?? DEFAULT_QUIT_STOP_TIMEOUT_MS;
  }

  getHostState(): ComputerUseHostRuntimeState {
    return (
      this.runtime?.getState() ??
      this.blockedHostState ??
      OFFLINE_COMPUTER_USE_HOST_STATE
    );
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
    options: { readonly userInitiated?: boolean } = {},
  ): Promise<void> {
    if (this.manualStopRequested && options.userInitiated !== true) {
      return;
    }
    this.manualStopRequested = false;

    const permissions = await this.refreshPermissions();
    if (!hasRequiredComputerUsePermissions(permissions)) {
      await this.detachRuntime();
      return;
    }
    const authState = await this.getAuthState();
    const startupGate = resolveComputerUseStartupGate({
      authState,
      permissions,
    });
    if (startupGate.status !== "ready") {
      await this.detachRuntime();
      if (startupGate.status === "blocked") {
        this.blockedHostState = startupGate.host;
        this.onChange();
      }
      return;
    }

    this.blockedHostState = null;
    this.runtime ??= this.createRuntime();
    await this.runtime.start();
    this.setHostRuntimeOnline(this.runtime.getState().status === "online");
  }

  /** User-initiated stop; suppresses auto-restarts until the next manual start. */
  async stop(): Promise<void> {
    this.manualStopRequested = true;
    this.setHostRuntimeOnline(false);
    await this.runtime?.stop();
    this.onChange();
  }

  /**
   * Detaches and stops the runtime when the auth session changes (sign-out or
   * a completed sign-in), so a subsequent start builds a fresh runtime.
   */
  async stopForAuthChange(): Promise<void> {
    await this.detachRuntime();
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
  async stopForQuit(): Promise<void> {
    if (this.quitStopStarted) {
      return;
    }
    this.quitStopStarted = true;
    const runtime = this.runtime;
    if (!runtime) {
      return;
    }
    this.setHostRuntimeOnline(false);
    await Promise.race([
      runtime.stop(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, this.quitStopTimeoutMs);
      }),
    ]);
  }

  private async detachRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.blockedHostState = null;
    this.setHostRuntimeOnline(false);
    try {
      await runtime?.stop();
    } finally {
      this.onChange();
    }
  }
}
