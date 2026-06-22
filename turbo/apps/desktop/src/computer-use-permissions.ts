import {
  createComputerUseNativeBackend,
  type ComputerUseNativeBackend,
} from "./computer-use-native";
import {
  defaultComputerUseAutomationPermissionState,
  normalizeComputerUsePermissionState,
  type ComputerUseAutomationPermissionTarget,
  type ComputerUsePermissionState,
} from "./computer-use-types";

const DEFAULT_COMPUTER_USE_PERMISSION_STATE: ComputerUsePermissionState =
  Object.freeze({
    accessibility: false,
    screenRecording: false,
    automation: defaultComputerUseAutomationPermissionState(),
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
  const permissions = await getNativeBackend().getPermissions();
  currentPermissionState = normalizeComputerUsePermissionState({
    ...permissions,
    automation: currentPermissionState.automation,
  });
  return currentPermissionState;
}

export async function requestComputerUseAccessibilityPermission(): Promise<ComputerUsePermissionState> {
  const permissions = await getNativeBackend().requestAccessibilityPermission();
  currentPermissionState = normalizeComputerUsePermissionState({
    ...permissions,
    automation: currentPermissionState.automation,
  });
  return currentPermissionState;
}

export async function requestComputerUseScreenRecordingPermission(): Promise<ComputerUsePermissionState> {
  const automation = currentPermissionState.automation;
  const permissions =
    await getNativeBackend().requestScreenRecordingPermission();
  currentPermissionState = normalizeComputerUsePermissionState({
    ...permissions,
    automation,
  });
  return currentPermissionState;
}

export async function probeComputerUseAutomationPermission(
  target: ComputerUseAutomationPermissionTarget,
): Promise<ComputerUsePermissionState> {
  const result = await getNativeBackend().probeAutomationPermission(target);
  currentPermissionState = normalizeComputerUsePermissionState({
    ...currentPermissionState,
    automation: {
      ...defaultComputerUseAutomationPermissionState(),
      ...currentPermissionState.automation,
      [target]: {
        ...result,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  return currentPermissionState;
}

export function recordComputerUseAutomationPermissionDenied(
  target: ComputerUseAutomationPermissionTarget,
  reason: string,
): ComputerUsePermissionState {
  currentPermissionState = normalizeComputerUsePermissionState({
    ...currentPermissionState,
    automation: {
      ...defaultComputerUseAutomationPermissionState(),
      ...currentPermissionState.automation,
      [target]: {
        status: "denied",
        updatedAt: new Date().toISOString(),
        reason,
      },
    },
  });
  return currentPermissionState;
}
