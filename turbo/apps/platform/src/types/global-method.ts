import type { FeatureSwitchKey } from "@vm0/core";

export type DebugLoggers = Record<
  string,
  {
    debug: boolean;
  }
>;

export type DebugFeatureSwitches = Partial<Record<FeatureSwitchKey, boolean>>;
