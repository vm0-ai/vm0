import type { ComputerUseNativeBackend } from "./computer-use-native";
import {
  defaultComputerUseAutomationPermissionState,
  normalizeComputerUsePermissionState,
  type ComputerUseAutomationPermissionTarget,
  type ComputerUsePermissionState,
} from "./computer-use-types";

export type ComputerUsePermissionProvider = Pick<
  ComputerUseNativeBackend,
  | "getPermissions"
  | "requestAccessibilityPermission"
  | "requestScreenRecordingPermission"
  | "probeAutomationPermission"
>;

export interface ComputerUsePermissionQuery {
  readonly signal?: AbortSignal;
  /** Absolute local monotonic deadline; never renewed by native recovery. */
  readonly deadline?: number;
}

const DEFAULT_COMPUTER_USE_PERMISSION_STATE: ComputerUsePermissionState =
  Object.freeze({
    accessibility: false,
    screenRecording: false,
    automation: defaultComputerUseAutomationPermissionState(),
  });

export function createComputerUsePermissions(
  withProvider: <T>(
    read: (provider: ComputerUsePermissionProvider) => Promise<T>,
  ) => Promise<T | null>,
  readPermissions: (
    query?: ComputerUsePermissionQuery,
  ) => Promise<ComputerUsePermissionState | null> = () =>
    withProvider((provider) => provider.getPermissions()),
) {
  let currentPermissionState = DEFAULT_COMPUTER_USE_PERMISSION_STATE;
  let revision = 0;

  function resetComputerUsePermissionState(): void {
    revision++;
    currentPermissionState = DEFAULT_COMPUTER_USE_PERMISSION_STATE;
  }

  function getComputerUsePermissionState(): ComputerUsePermissionState {
    return currentPermissionState;
  }

  async function refreshComputerUsePermissionState(
    query?: ComputerUsePermissionQuery,
  ): Promise<ComputerUsePermissionState> {
    const current = revision;
    const permissions = await readPermissions(query);
    if (!permissions || current !== revision) return currentPermissionState;
    currentPermissionState = normalizeComputerUsePermissionState({
      ...permissions,
      automation: currentPermissionState.automation,
    });
    return currentPermissionState;
  }

  async function requestComputerUseAccessibilityPermission(): Promise<ComputerUsePermissionState> {
    const current = revision;
    const permissions = await withProvider((provider) =>
      provider.requestAccessibilityPermission(),
    );
    if (!permissions || current !== revision) return currentPermissionState;
    currentPermissionState = normalizeComputerUsePermissionState({
      ...permissions,
      automation: currentPermissionState.automation,
    });
    return currentPermissionState;
  }

  async function requestComputerUseScreenRecordingPermission(): Promise<ComputerUsePermissionState> {
    const current = revision;
    const automation = currentPermissionState.automation;
    const permissions = await withProvider((provider) =>
      provider.requestScreenRecordingPermission(),
    );
    if (!permissions || current !== revision) return currentPermissionState;
    currentPermissionState = normalizeComputerUsePermissionState({
      ...permissions,
      automation,
    });
    return currentPermissionState;
  }

  async function probeComputerUseAutomationPermission(
    target: ComputerUseAutomationPermissionTarget,
  ): Promise<ComputerUsePermissionState> {
    const current = revision;
    const result = await withProvider((provider) =>
      provider.probeAutomationPermission(target),
    );
    if (!result || current !== revision) return currentPermissionState;
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

  function recordComputerUseAutomationPermissionDenied(
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

  return {
    resetComputerUsePermissionState,
    getComputerUsePermissionState,
    refreshComputerUsePermissionState,
    requestComputerUseAccessibilityPermission,
    requestComputerUseScreenRecordingPermission,
    probeComputerUseAutomationPermission,
    recordComputerUseAutomationPermissionDenied,
  };
}
