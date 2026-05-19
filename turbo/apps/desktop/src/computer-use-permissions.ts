import { systemPreferences } from "electron";
import type { ComputerUsePermissionState } from "./computer-use-page";

export function getComputerUsePermissionState(): ComputerUsePermissionState {
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording:
      systemPreferences.getMediaAccessStatus("screen") === "granted",
  };
}
