export type RunnerAdmittableProfiles = string[];

export interface RunnerHeldSessionState {
  readonly sessionId: string;
  readonly reuseKey: string;
  readonly lastCompletedAt: string;
  readonly reusableSandbox: {
    readonly profile: string;
    readonly historyGenerationRunId?: string;
  };
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
