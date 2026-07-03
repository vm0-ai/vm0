import type {
  ComputerUseHostRuntimeStatus,
  DesktopComputerUseState,
} from "./computer-use-types";

const MAIN_PROCESS_AUTO_START_STATUSES = new Set<ComputerUseHostRuntimeStatus>([
  "unauthenticated",
]);

interface DesktopComputerUseAutoStartSupervisorOptions {
  readonly getState: () => DesktopComputerUseState;
  readonly start: () => Promise<void>;
  readonly logError: (error: unknown) => void;
  readonly setTimeout?: typeof setTimeout;
}

export class DesktopComputerUseAutoStartSupervisor {
  private readonly getState: () => DesktopComputerUseState;
  private readonly start: () => Promise<void>;
  private readonly logError: (error: unknown) => void;
  private readonly scheduleTimeout: typeof setTimeout;
  private scheduled = false;
  private running = false;

  constructor(options: DesktopComputerUseAutoStartSupervisorOptions) {
    this.getState = options.getState;
    this.start = options.start;
    this.logError = options.logError;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
  }

  requestStart(): void {
    if (this.scheduled || this.running) {
      return;
    }

    this.scheduled = true;
    this.scheduleTimeout(() => {
      this.scheduled = false;
      void this.run();
    }, 0);
  }

  restartRecoverableRuntimeState(): void {
    if (MAIN_PROCESS_AUTO_START_STATUSES.has(this.getState().host.status)) {
      this.requestStart();
    }
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.start();
    } catch (error) {
      this.logError(error);
    } finally {
      this.running = false;
    }
  }
}
