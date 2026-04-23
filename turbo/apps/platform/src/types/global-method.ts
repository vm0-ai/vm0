import type { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

export type DebugLoggers = Record<
  string,
  {
    debug: boolean;
  }
>;

export type DebugFeatureSwitches = Partial<Record<FeatureSwitchKey, boolean>>;
