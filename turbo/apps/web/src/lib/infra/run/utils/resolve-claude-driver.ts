import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

export type ClaudeDriver = "print" | "interactive";

interface ResolveClaudeDriverParams {
  readonly resolvedModelProvider?: ModelProviderType;
  readonly featureFlags: Record<string, boolean>;
}

export function resolveClaudeDriver(
  params: ResolveClaudeDriverParams,
): ClaudeDriver {
  if (
    params.resolvedModelProvider === "claude-code-oauth-token" &&
    params.featureFlags[FeatureSwitchKey.ClaudeInteractiveDriver] === true
  ) {
    return "interactive";
  }

  return "print";
}
