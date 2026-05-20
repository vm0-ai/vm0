import { systemPreferences } from "electron";
import type { ComputerUsePermissionState } from "./computer-use-types";

export function getComputerUsePermissionState(): ComputerUsePermissionState {
  return {
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording:
      systemPreferences.getMediaAccessStatus("screen") === "granted",
  };
}

export function requestComputerUseAccessibilityPermission(): ComputerUsePermissionState {
  if (process.platform === "darwin") {
    systemPreferences.isTrustedAccessibilityClient(true);
  }
  return getComputerUsePermissionState();
}
