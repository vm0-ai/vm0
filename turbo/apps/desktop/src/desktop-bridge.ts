import type {
  ComputerUseApprovalAction,
  DesktopComputerUseState,
} from "./computer-use-types";

export interface DesktopAuthApi {
  readonly openSignIn: () => Promise<void>;
  readonly openOrgSelection: () => Promise<void>;
  readonly completeSignIn: (params: {
    readonly token: string;
  }) => Promise<void>;
  readonly subscribe: (callback: () => void) => () => void;
}

export interface DesktopComputerUseApi {
  readonly getState: () => Promise<DesktopComputerUseState>;
  readonly start: () => Promise<DesktopComputerUseState>;
  readonly requestAccessibilityPermission: () => Promise<DesktopComputerUseState>;
  readonly openAccessibilitySettings: () => Promise<void>;
  readonly openScreenRecordingSettings: () => Promise<void>;
  readonly decideCommand: (
    action: ComputerUseApprovalAction,
  ) => Promise<DesktopComputerUseState>;
  readonly subscribe: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    vm0DesktopAuth?: DesktopAuthApi;
    vm0DesktopComputerUse?: DesktopComputerUseApi;
  }
}

export {};
