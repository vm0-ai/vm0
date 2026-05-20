export const COMPUTER_USE_FEATURE_SWITCH_KEY = "computerUse";

export interface ComputerUsePermissionState {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export type ComputerUseHostRuntimeStatus =
  | "idle"
  | "connecting"
  | "online"
  | "unauthenticated"
  | "disabled"
  | "error";

export interface ComputerUsePendingApprovalRuntimeEvent {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly createdAt: string;
}

export interface ComputerUseRuntimeAuditEvent {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly event: "created" | "approved" | "denied" | "completed";
  readonly approvalOutcome: "approved" | "denied" | null;
  readonly createdAt: string;
}

export interface ComputerUseHostRuntimeState {
  readonly status: ComputerUseHostRuntimeStatus;
  readonly hostId: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastCommandAt: string | null;
  readonly lastError: string | null;
  readonly pendingApprovals: readonly ComputerUsePendingApprovalRuntimeEvent[];
  readonly recentAuditEvents: readonly ComputerUseRuntimeAuditEvent[];
}

export interface ComputerUseApprovalAction {
  readonly commandId: string;
  readonly decision: "approve" | "deny";
}

export interface DesktopComputerUseState {
  readonly featureSwitchKey: typeof COMPUTER_USE_FEATURE_SWITCH_KEY;
  readonly platform: NodeJS.Platform;
  readonly supported: boolean;
  readonly permissions: ComputerUsePermissionState;
  readonly host: ComputerUseHostRuntimeState;
}

export const IDLE_COMPUTER_USE_HOST_STATE: ComputerUseHostRuntimeState =
  Object.freeze({
    status: "idle",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    pendingApprovals: [],
    recentAuditEvents: [],
  });
