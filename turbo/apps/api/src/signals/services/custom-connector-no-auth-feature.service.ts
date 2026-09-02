import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

export function isCustomConnectorNoAuthEnabled(
  context: FeatureSwitchContext,
): boolean {
  return isFeatureEnabled(FeatureSwitchKey.CustomConnectorNoAuth, context);
}
