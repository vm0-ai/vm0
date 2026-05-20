import type { DebugLoggers } from "./types/global-method";

interface VM0Global {
  loggers: DebugLoggers;
  inspectLogs: () => void;
}

type DesktopLocalAgentBackend = "codex" | "claude-code";

type DesktopLocalAgentPermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "dontAsk"
  | "plan"
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

type DesktopLocalAgentStatus =
  | "stopped"
  | "starting"
  | "online"
  | "stopping"
  | "error";

interface DesktopLocalAgentBackendProbe {
  readonly backend: DesktopLocalAgentBackend;
  readonly command: string;
  readonly available: boolean;
  readonly executablePath?: string;
  readonly version?: string;
  readonly errorMessage?: string;
}

interface DesktopLocalAgentEntry {
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

interface DesktopLocalAgentAddOptions {
  readonly backend?: DesktopLocalAgentBackend;
  readonly permissionMode?: DesktopLocalAgentPermissionMode;
}

interface DesktopLocalAgentApi {
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly list: () => Promise<DesktopLocalAgentEntry[]>;
  readonly detectBackends: () => Promise<DesktopLocalAgentBackendProbe[]>;
  readonly add: (
    options?: DesktopLocalAgentAddOptions,
  ) => Promise<DesktopLocalAgentEntry | null>;
  readonly start: (id: string) => Promise<DesktopLocalAgentEntry>;
  readonly stop: (id: string) => Promise<DesktopLocalAgentEntry>;
  readonly remove: (id: string) => Promise<void>;
  readonly openFolder: (id: string) => Promise<void>;
  readonly subscribe: (callback: () => void) => () => void;
}

declare global {
  interface Window {
    _vm0: VM0Global | undefined;
    vm0DesktopLocalAgent?: DesktopLocalAgentApi;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
  }
}

export {};
