import type { DebugLoggers } from "./types/global-method";

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
}

type DesktopComputerUseHostStatus =
  | "idle"
  | "connecting"
  | "online"
  | "unauthenticated"
  | "disabled"
  | "error";

interface DesktopComputerUsePermissionState {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

interface DesktopComputerUsePendingApproval {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly createdAt: string;
}

interface DesktopComputerUseAuditEvent {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly event: "created" | "approved" | "denied" | "completed";
  readonly approvalOutcome: "approved" | "denied" | null;
  readonly redactedResult?: Record<string, unknown> | null;
  readonly createdAt: string;
}

interface DesktopComputerUseHostState {
  readonly status: DesktopComputerUseHostStatus;
  readonly hostId: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastCommandAt: string | null;
  readonly lastError: string | null;
  readonly pendingApprovals: readonly DesktopComputerUsePendingApproval[];
  readonly recentAuditEvents: readonly DesktopComputerUseAuditEvent[];
}

interface DesktopComputerUseState {
  readonly featureSwitchKey: "computerUse";
  readonly platform: string;
  readonly supported: boolean;
  readonly permissions: DesktopComputerUsePermissionState;
  readonly host: DesktopComputerUseHostState;
}

interface DesktopComputerUseApprovalAction {
  readonly commandId: string;
  readonly decision: "approve" | "deny";
}

interface DesktopComputerUseApi {
  readonly getState: () => Promise<DesktopComputerUseState>;
  readonly start: () => Promise<DesktopComputerUseState>;
  readonly requestAccessibilityPermission: () => Promise<DesktopComputerUseState>;
  readonly openAccessibilitySettings: () => Promise<void>;
  readonly openScreenRecordingSettings: () => Promise<void>;
  readonly decideCommand: (
    action: DesktopComputerUseApprovalAction,
  ) => Promise<DesktopComputerUseState>;
  readonly subscribe: (callback: () => void) => () => void;
}

interface DesktopWindowChromeApi {
  readonly setSidebarCollapsed: (collapsed: boolean) => Promise<void>;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
    vm0DesktopComputerUse?: DesktopComputerUseApi;
    vm0DesktopWindowChrome?: DesktopWindowChromeApi;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
  }
}

export {};
