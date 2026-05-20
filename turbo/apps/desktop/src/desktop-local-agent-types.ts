export type DesktopLocalAgentBackend = "codex" | "claude-code";

export type DesktopLocalAgentPermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "plan"
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export type DesktopLocalAgentStatus =
  | "stopped"
  | "starting"
  | "online"
  | "stopping"
  | "error";

export interface DesktopLocalAgentBackendProbe {
  readonly backend: DesktopLocalAgentBackend;
  readonly command: string;
  readonly available: boolean;
  readonly executablePath?: string;
  readonly version?: string;
  readonly errorMessage?: string;
}

export interface DesktopLocalAgentEntry {
  readonly id: string;
  readonly name: string;
  readonly folderPath: string;
  readonly backend: DesktopLocalAgentBackend;
  readonly permissionMode: DesktopLocalAgentPermissionMode;
  readonly status: DesktopLocalAgentStatus;
  readonly executablePath?: string;
  readonly hostId?: string;
  readonly lastHeartbeatAt?: string;
  readonly errorMessage?: string;
}

export interface DesktopLocalAgentAddOptions {
  readonly backend?: DesktopLocalAgentBackend;
  readonly permissionMode?: DesktopLocalAgentPermissionMode;
}

export interface DesktopLocalAgentHostStartResponse {
  readonly hostId: string;
  readonly hostToken: string;
}

export interface DesktopLocalAgentJob {
  readonly id: string;
  readonly backend: DesktopLocalAgentBackend;
  readonly prompt: string;
}

export type DesktopLocalAgentJobNextResponse =
  | { readonly status: "idle" }
  | { readonly status: "job"; readonly job: DesktopLocalAgentJob };

export interface DesktopLocalAgentExecutionResult {
  readonly output: string;
  readonly error?: string;
  readonly exitCode: number;
  readonly backendHealthy?: boolean;
}
