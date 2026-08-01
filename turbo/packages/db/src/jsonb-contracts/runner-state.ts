export type RunnerAdmittableProfiles = string[];

export interface RunnerHeldSessionState {
  // Compatibility JSON field name. Workspace-only heartbeat records omit it;
  // reusable sandbox records always retain the CLI agent session id.
  readonly sessionId?: string;
  // Optional while older runners drain during deployment.
  readonly reuseKey?: string;
  readonly lastCompletedAt: string;
  readonly reusableSandbox?: {
    readonly profile: string;
    readonly historyGenerationRunId?: string;
  };
  readonly workspaceCaches?: readonly {
    readonly profile: string;
    readonly workspaceAffinityVersion?: 1;
  }[];
}

export type RunnerHeldSessionStates = RunnerHeldSessionState[];

interface RunnerHeldWorkspaceCache {
  readonly profile: string;
  readonly workspaceAffinityVersion: 1;
}

export interface RunnerHeldWorkspaceState {
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly workspaceCaches: readonly [
    RunnerHeldWorkspaceCache,
    ...RunnerHeldWorkspaceCache[],
  ];
}

export type RunnerHeldWorkspaceStates = RunnerHeldWorkspaceState[];
