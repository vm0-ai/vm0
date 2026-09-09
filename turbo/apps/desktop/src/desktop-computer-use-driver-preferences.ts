import type {
  ComputerUseDriverId,
  ComputerUseDriverPreference,
} from "./computer-use-types";
import {
  readDesktopPreferenceRecord,
  writeDesktopPreferenceRecord,
} from "./desktop-preferences";

const DEFAULT: ComputerUseDriverPreference = {
  experimentalCuaEnabled: false,
  selectedDriver: "okou",
};

/** Installation preferences are requests, never execution or account authority. */
export class DesktopComputerUseDriverPreferences {
  private preference: ComputerUseDriverPreference = DEFAULT;
  private error: string | null = null;

  constructor(private readonly getPath: () => string) {}

  getState() {
    return { ...this.preference, preferenceError: this.error };
  }

  load(): void {
    try {
      const value = readDesktopPreferenceRecord(
        this.getPath(),
      ).computerUseDriver;
      this.preference =
        typeof value === "object" &&
        value !== null &&
        "experimentalCuaEnabled" in value &&
        value.experimentalCuaEnabled === true &&
        "selectedDriver" in value &&
        (value.selectedDriver === "okou" || value.selectedDriver === "cua")
          ? {
              experimentalCuaEnabled: true,
              selectedDriver: value.selectedDriver,
            }
          : DEFAULT;
      this.error = null;
    } catch {
      this.preference = DEFAULT;
      this.error =
        "Driver preferences could not be read. Repair the preferences file before saving.";
    }
  }

  setExperiment(enabled: boolean): void {
    this.save({
      experimentalCuaEnabled: enabled,
      // The explicit experiment IPC does not activate CUA. Opting out requests Okou.
      selectedDriver: enabled ? this.preference.selectedDriver : "okou",
    });
  }

  select(selectedDriver: ComputerUseDriverId): void {
    // The authorized explicit choice commits opt-in and selection together.
    this.save({
      experimentalCuaEnabled:
        selectedDriver === "cua" || this.preference.experimentalCuaEnabled,
      selectedDriver,
    });
  }

  private save(preference: ComputerUseDriverPreference): void {
    try {
      // No await between read and write: other main-process preference owners
      // cannot interleave a stale whole-file write into this transaction.
      const filePath = this.getPath();
      const current = readDesktopPreferenceRecord(filePath);
      writeDesktopPreferenceRecord(filePath, {
        ...current,
        computerUseDriver: preference,
      });
      this.preference = preference;
      this.error = null;
    } catch {
      this.error =
        "Driver preferences could not be saved. The previous selection is retained.";
      throw new Error(this.error);
    }
  }
}
