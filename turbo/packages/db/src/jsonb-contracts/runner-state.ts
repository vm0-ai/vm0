export type RunnerAdmittableProfiles = string[];

export interface RunnerHeldSessionState {
  // Compatibility JSON field name. Semantically this is the CLI agent session
  // id that keys runner sandbox reuse affinity.
  readonly sessionId: string;
  readonly lastCompletedAt: string;
}

export type RunnerHeldSessionStates = RunnerHeldSessionState[];
