import {
  createComputerUseNativeBackend,
  type ComputerUseNativeBackend,
} from "./computer-use-native";
import type { ComputerUsePermissionState } from "./computer-use-types";

const DEFAULT_COMPUTER_USE_PERMISSION_STATE: ComputerUsePermissionState =
  Object.freeze({
    accessibility: false,
    screenRecording: false,
  });

let nativeBackend: ComputerUseNativeBackend | null = null;
let currentPermissionState = DEFAULT_COMPUTER_USE_PERMISSION_STATE;

export function setComputerUsePermissionNativeBackend(
  backend: ComputerUseNativeBackend,
): void {
  nativeBackend = backend;
}

function getNativeBackend(): ComputerUseNativeBackend {
  nativeBackend ??= createComputerUseNativeBackend();
  return nativeBackend;
}

export function getComputerUsePermissionState(): ComputerUsePermissionState {
  return currentPermissionState;
}

export async function refreshComputerUsePermissionState(): Promise<ComputerUsePermissionState> {
  currentPermissionState = await getNativeBackend().getPermissions();
  return currentPermissionState;
}

export async function requestComputerUseAccessibilityPermission(): Promise<ComputerUsePermissionState> {
  currentPermissionState =
    await getNativeBackend().requestAccessibilityPermission();
  return currentPermissionState;
}

export async function requestComputerUseScreenRecordingPermission(): Promise<ComputerUsePermissionState> {
  currentPermissionState =
    await getNativeBackend().requestScreenRecordingPermission();
  return currentPermissionState;
}
