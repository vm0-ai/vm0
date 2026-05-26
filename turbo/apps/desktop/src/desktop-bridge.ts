import type { DesktopComputerUseState } from "./computer-use-types";

export interface DesktopAuthUser {
  readonly userId: string;
  readonly email: string;
}

export interface DesktopAuthOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string | null;
}

export type DesktopAuthState =
  | {
      readonly status: "signed_out";
      readonly user: null;
      readonly organization: null;
    }
  | {
      readonly status: "signed_in";
      readonly user: DesktopAuthUser;
      readonly organization: DesktopAuthOrganization | null;
    };

export interface DesktopAuthApi {
  readonly getState: () => Promise<DesktopAuthState>;
  readonly openSignIn: () => Promise<void>;
  readonly openOrgSelection: () => Promise<void>;
  readonly completeSignIn: (params: {
    readonly token: string;
  }) => Promise<void>;
  readonly subscribe: (callback: () => void) => () => void;
}

export interface DesktopComputerUseApi {
  readonly getState: () => Promise<DesktopComputerUseState>;
  readonly refreshPermissions: () => Promise<DesktopComputerUseState>;
  readonly start: () => Promise<DesktopComputerUseState>;
  readonly requestAccessibilityPermission: () => Promise<DesktopComputerUseState>;
  readonly requestScreenRecordingPermission: () => Promise<DesktopComputerUseState>;
  readonly openAccessibilitySettings: () => Promise<void>;
  readonly openScreenRecordingSettings: () => Promise<void>;
  readonly subscribe: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    vm0DesktopAuth?: DesktopAuthApi;
    vm0DesktopComputerUse?: DesktopComputerUseApi;
  }
}

export {};
