import { systemPreferences, shell } from "electron";
import type { ComputerUsePermissionProvider } from "./computer-use-permissions";

/** Electron's signed host can inspect TCC without loading either actuator. */
export function createComputerUseHostPermissions(
  platform: NodeJS.Platform = process.platform,
): ComputerUsePermissionProvider {
  const getPermissions = async () => ({
    accessibility:
      platform === "darwin" &&
      systemPreferences.isTrustedAccessibilityClient(false),
    screenRecording:
      platform === "darwin" &&
      systemPreferences.getMediaAccessStatus("screen") === "granted",
  });
  return {
    getPermissions,
    requestAccessibilityPermission: async () => {
      if (platform === "darwin")
        systemPreferences.isTrustedAccessibilityClient(true);
      return getPermissions();
    },
    requestScreenRecordingPermission: async () => {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      );
      return getPermissions();
    },
    probeAutomationPermission: async () => ({
      status: "unknown",
      updatedAt: null,
      reason: "CUA does not use browser Apple Events automation",
    }),
  };
}
