import type { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

export type ConnectorFeatureStates =
  | Partial<Record<FeatureSwitchKey, boolean>>
  | null
  | undefined;
