import { createComputerUseNativeBackend } from "./computer-use-native";
import type { ComputerUsePermissionState } from "./computer-use-types";

const DEFAULT_COMPUTER_USE_PERMISSION_STATE: ComputerUsePermissionState =
  Object.freeze({
    accessibility: false,
    screenRecording: false,
  });

const nativeBackend = createComputerUseNativeBackend();
let currentPermissionState = DEFAULT_COMPUTER_USE_PERMISSION_STATE;

export function getComputerUsePermissionState(): ComputerUsePermissionState {
  return currentPermissionState;
}

export async function refreshComputerUsePermissionState(): Promise<ComputerUsePermissionState> {
  currentPermissionState = await nativeBackend.getPermissions();
  return currentPermissionState;
}

export async function requestComputerUseAccessibilityPermission(): Promise<ComputerUsePermissionState> {
  currentPermissionState = await nativeBackend.requestAccessibilityPermission();
  return currentPermissionState;
}
