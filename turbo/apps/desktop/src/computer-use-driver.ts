import type { ComputerUsePermissionProvider } from "./computer-use-permissions";
import { createComputerUseDrain } from "./computer-use-lifecycle-deadline";
import {
  ComputerUseSnapshotStore,
  executeComputerUseCommand,
  type ComputerUseCommand,
  type ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type {
  ComputerUseNativeBackend,
  ComputerUseNativeShutdownReason,
} from "./computer-use-native";
import type { ComputerUsePermissionState } from "./computer-use-types";

export interface ComputerUseDriver {
  readonly id: string;
  readonly createBackend: () => ComputerUseNativeBackend;
}

interface DriverGeneration {
  readonly driver: ComputerUseDriver;
  readonly generation: number;
  readonly backend: ComputerUseNativeBackend;
  readonly snapshots: ComputerUseSnapshotStore;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
  leases: number;
  disposal: Promise<void> | null;
}

export interface ComputerUseCommandSession {
  getPermissions(): Promise<ComputerUsePermissionState>;
  executeCommand(
    command: ComputerUseCommand,
    permissions: ComputerUsePermissionState,
  ): Promise<ComputerUseCommandExecutionResult>;
  release(): void;
}

/** Owns native resources, including passive permission probes, for one generation. */
export class ComputerUseDriverController {
  private context: DriverGeneration | null = null;
  private retirement: Promise<void> | null = null;
  private retiringContext: DriverGeneration | null = null;
  private nextGeneration = 0;
  private active = false;
  private permissionsPaused = false;
  private closed = false;

  constructor(
    private driver: ComputerUseDriver,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get generation(): number | null {
    return this.context?.generation ?? null;
  }

  private prepare(): DriverGeneration {
    if (this.closed || this.retirement) {
      throw new Error("Computer Use driver retirement is not complete");
    }
    if (!this.context) {
      const { promise, resolve } = createComputerUseDrain();
      this.context = {
        driver: this.driver,
        generation: ++this.nextGeneration,
        backend: this.driver.createBackend(),
        snapshots: new ComputerUseSnapshotStore(),
        drained: promise,
        resolveDrained: resolve,
        leases: 0,
        disposal: null,
      };
    }
    return this.context;
  }

  activate(): void {
    this.prepare();
    this.active = true;
    this.permissionsPaused = false;
  }

  pausePermissions(): void {
    this.permissionsPaused = true;
  }

  async withPermissionProvider<T>(
    read: (provider: ComputerUsePermissionProvider) => Promise<T>,
  ): Promise<T | null> {
    if (this.closed || this.retirement || this.permissionsPaused) return null;
    // Creating the selected driver's probe context does not admit commands.
    const context = this.prepare();
    const release = this.lease(context);
    try {
      const result = await read(context.backend);
      return this.context === context ? result : null;
    } finally {
      release();
    }
  }

  acquireCommand(): ComputerUseCommandSession {
    const context = this.context;
    if (!this.active || !context) {
      throw new Error("Computer Use driver is not ready");
    }
    return {
      getPermissions: () => context.backend.getPermissions(),
      executeCommand: async (command, permissions) => {
        const { app, snapshotId } = command.payload;
        if (
          typeof app === "string" &&
          typeof snapshotId === "string" &&
          !context.snapshots.get(app, snapshotId)
        ) {
          return {
            status: "failed",
            error: {
              code: "unsupported_command",
              message: `Snapshot not found for ${app}: ${snapshotId}`,
            },
          };
        }
        return executeComputerUseCommand(command, permissions, {
          nativeBackend: context.backend,
          snapshotStore: context.snapshots,
          platform: this.platform,
        });
      },
      release: this.lease(context),
    };
  }

  private lease(context: DriverGeneration): () => void {
    context.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      context.leases--;
      if (this.context !== context && context.leases === 0) {
        context.resolveDrained();
      }
    };
  }

  retire(reason: ComputerUseNativeShutdownReason = "dispose"): Promise<void> {
    this.active = false;
    this.permissionsPaused = true;
    if (reason !== "dispose") this.closed = true;
    if (this.retirement) {
      if (reason !== "dispose" && this.retiringContext) {
        return this.dispose(this.retiringContext, reason);
      }
      return this.retirement;
    }
    const context = this.context;
    this.context = null;
    if (!context) return Promise.resolve();
    this.retiringContext = context;
    if (context.leases === 0) context.resolveDrained();
    const retirement = (async () => {
      // Quit may terminate native work; a healthy replacement must drain it.
      if (reason === "dispose") await context.drained;
      await this.dispose(context, reason);
    })();
    this.retirement = retirement;
    void retirement.then(
      () => {
        if (this.retirement === retirement) {
          this.retirement = null;
          this.retiringContext = null;
        }
      },
      () => {
        // Keep failed cleanup owned. A retry must not overlap the old backend.
      },
    );
    return retirement;
  }

  private dispose(
    context: DriverGeneration,
    reason: ComputerUseNativeShutdownReason,
  ): Promise<void> {
    context.disposal ??= context.backend.dispose(reason).then(() => {
      context.snapshots.clear();
    });
    return context.disposal;
  }

  /** Called only after the lifecycle owner has proved retirement and intent. */
  select(driver: ComputerUseDriver): void {
    if (this.context || this.retirement || this.closed) {
      throw new Error(
        "Computer Use driver is still owned by the old generation",
      );
    }
    this.driver = driver;
    this.permissionsPaused = false;
  }

  resumePermissions(): void {
    if (!this.closed && !this.retirement) this.permissionsPaused = false;
  }
}
