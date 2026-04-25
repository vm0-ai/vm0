import type { FeatureSwitchKey } from "@vm0/api-contracts/feature-switch-key";

export type DebugLoggers = Record<
  string,
  {
    debug: boolean;
  }
>;

export type DebugFeatureSwitches = Partial<Record<FeatureSwitchKey, boolean>>;
