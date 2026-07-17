export type RunnerAdmittableProfiles = string[];

export interface RunnerHeldSessionState {
  // Compatibility JSON field name. Semantically this is the CLI agent session
  // id that keys runner sandbox reuse affinity.
  readonly sessionId: string;
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
