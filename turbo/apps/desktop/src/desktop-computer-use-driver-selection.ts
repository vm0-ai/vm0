import type { ComputerUseDriver } from "./computer-use-driver";
import type { ComputerUseRuntimeController } from "./computer-use-runtime-controller";
import type {
  ComputerUseDriverId,
  DesktopComputerUseDriverState,
} from "./computer-use-types";
import type { DeveloperToolsController } from "./desktop-developer-tools-controller";
import type { DesktopComputerUseDriverPreferences } from "./desktop-computer-use-driver-preferences";
import artifacts from "../cua/artifacts.json";

/** Local policy/bridge adapter. All execution and replacement stay in the runtime owner. */
export class DesktopComputerUseDriverSelection {
  constructor(
    private readonly options: {
      readonly preferences: DesktopComputerUseDriverPreferences;
      readonly developer: DeveloperToolsController;
      readonly runtime: ComputerUseRuntimeController;
      readonly drivers: Readonly<
        Record<ComputerUseDriverId, ComputerUseDriver>
      >;
      readonly onChange: () => void;
    },
  ) {}

  requestedDriver(): ComputerUseDriver {
    return this.options.drivers[
      this.options.preferences.getState().selectedDriver
    ];
  }

  blockReason(driver: ComputerUseDriver): string | null {
    const preference = this.options.preferences.getState();
    if (preference.preferenceError) return preference.preferenceError;
    if (driver.id !== "cua") return null;
    if (
      !preference.experimentalCuaEnabled ||
      preference.selectedDriver !== "cua"
    )
      return "CUA requires an explicit experimental selection.";
    if (!this.options.developer.getAuthorization())
      return "CUA requires current Developer access. Sign in or use Okou.";
    return null;
  }

  getState(): DesktopComputerUseDriverState {
    const preference = this.options.preferences.getState();
    const runtime = this.options.runtime.getDriverState();
    return {
      experimentalCuaEnabled: preference.experimentalCuaEnabled,
      selectedDriver: preference.selectedDriver,
      ...runtime,
      error: preference.preferenceError ?? runtime.error,
      developerAvailability: this.options.developer.getAvailability(),
      expectedCuaVersion: artifacts.driverVersion,
    };
  }

  async setExperiment(enabled: boolean): Promise<void> {
    if (enabled) this.requireDeveloper();
    await this.save(() => this.options.preferences.setExperiment(enabled));
    // The experiment IPC alone never switches to CUA; selection is explicit.
    if (!enabled) await this.apply();
  }

  async select(driver: ComputerUseDriverId): Promise<void> {
    if (driver === "cua") this.requireDeveloper();
    await this.save(() => this.options.preferences.select(driver));
    await this.apply();
  }

  private requireDeveloper(): void {
    if (!this.options.developer.getAuthorization())
      throw new Error("Current Developer access is required");
  }

  private async save(write: () => void): Promise<void> {
    try {
      write();
    } catch (error) {
      // A failed preference transaction cannot authorize further CUA work.
      await this.options.runtime.refreshDriverAuthorization();
      throw error;
    } finally {
      this.options.onChange();
    }
  }

  private async apply(): Promise<void> {
    try {
      await this.options.runtime.transitionDriver(this.requestedDriver());
    } catch {
      // The runtime retains cleanup ownership and reports a bounded error.
      // Do not expose a raw SDK/process error across IPC or replay the action.
    } finally {
      this.options.onChange();
    }
  }
}
