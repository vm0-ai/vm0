export type RunnerAdmittableProfiles = string[];

export interface RunnerHeldSessionState {
  // Intentionally optional for persisted pre-scope rows and rolling runner/API
  // compatibility. Scoped affinity ignores states that omit this
  // server-authoritative application session id.
  readonly sandboxReuseScope?: string;
  // Compatibility JSON field name. Semantically this is the CLI agent session
  // component of the scoped runner reuse identity and is not authoritative by
  // itself.
  readonly sessionId: string;
  readonly lastCompletedAt: string;
  readonly reusableSandbox?: {
    readonly profile: string;
  };
}

export type RunnerHeldSessionStates = RunnerHeldSessionState[];
