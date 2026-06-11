export const COMPUTER_USE_FEATURE_SWITCH_KEY = "computerUse";

export interface ComputerUsePermissionState {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export type ComputerUseHostRuntimeStatus =
  | "offline"
  | "connecting"
  | "online"
  | "recovering"
  | "unauthenticated"
  | "needs_organization"
  | "disabled"
  | "error";

export type ComputerUseRuntimeRecoveryPhase =
  | "start"
  | "heartbeat"
  | "command_poll";

export interface ComputerUseRuntimeRecoveryState {
  readonly phase: ComputerUseRuntimeRecoveryPhase;
  readonly attempt: number;
  readonly nextRetryAt: string;
  readonly lastRetryAt: string;
  readonly retryDelayMs: number;
}

export interface ComputerUseRuntimeAuditEvent {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly event: "created" | "approved" | "denied" | "completed";
  readonly approvalOutcome: "approved" | "denied" | null;
  readonly redactedResult?: Record<string, unknown> | null;
  readonly createdAt: string;
}

export type ComputerUseLocalCommandLogStatus =
  | "running"
  | "succeeded"
  | "failed";

export interface ComputerUseLocalCommandLogEntry {
  readonly commandId: string;
  readonly kind: string;
  readonly app: string | null;
  readonly status: ComputerUseLocalCommandLogStatus;
  readonly payload: Record<string, unknown>;
  readonly result: Record<string, unknown> | null;
  readonly error: Record<string, unknown> | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
}

export type ComputerUseRuntimeErrorSource =
  | "audit"
  | "start"
  | "stop"
  | "heartbeat"
  | "command_poll";

export interface ComputerUseRuntimeErrorLogEntry {
  readonly id: string;
  readonly source: ComputerUseRuntimeErrorSource;
  readonly message: string;
  readonly occurredAt: string;
  readonly hostId: string | null;
  readonly status: Extract<ComputerUseHostRuntimeStatus, "error">;
}

export interface ComputerUseHostRuntimeState {
  readonly status: ComputerUseHostRuntimeStatus;
  readonly hostId: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly lastCommandAt: string | null;
  readonly lastError: string | null;
  readonly recovery: ComputerUseRuntimeRecoveryState | null;
  readonly errorLog: readonly ComputerUseRuntimeErrorLogEntry[];
  readonly recentAuditEvents: readonly ComputerUseRuntimeAuditEvent[];
  readonly localCommandLog: readonly ComputerUseLocalCommandLogEntry[];
}

export interface DesktopKeepAwakeState {
  readonly enabled: boolean;
  readonly active: boolean;
}

export interface DesktopComputerUseState {
  readonly featureSwitchKey: typeof COMPUTER_USE_FEATURE_SWITCH_KEY;
  readonly platform: NodeJS.Platform;
  readonly supported: boolean;
  readonly permissions: ComputerUsePermissionState;
  readonly host: ComputerUseHostRuntimeState;
  readonly keepAwake: DesktopKeepAwakeState;
}

export function hasRequiredComputerUsePermissions(
  permissions: ComputerUsePermissionState,
): boolean {
  return permissions.accessibility && permissions.screenRecording;
}

export const OFFLINE_COMPUTER_USE_HOST_STATE: ComputerUseHostRuntimeState =
  Object.freeze({
    status: "offline",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    recovery: null,
    errorLog: [],
    recentAuditEvents: [],
    localCommandLog: [],
  });
