import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

export function isCustomConnectorMcpEnabled(
  context: FeatureSwitchContext,
): boolean {
  return isFeatureEnabled(FeatureSwitchKey.CustomConnectorMcp, context);
}

export function customConnectorMcpDisabledResponse() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "MCP custom connector management is not enabled",
        code: "FORBIDDEN" as const,
      },
    },
  };
}
