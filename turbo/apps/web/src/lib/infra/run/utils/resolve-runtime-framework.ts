import {
  getFrameworkForType,
  type ModelProviderFramework,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  getValidatedFramework,
  type SupportedFramework,
} from "@vm0/core/frameworks";
import { extractFrameworkFromCompose } from "../../framework/framework-config";

interface ResolveRuntimeFrameworkParams {
  /** Final framework from Zero model-provider resolution. */
  resolvedFramework?: string | null;
  /** Framework already resolved from a model route, including meta-provider concretes. */
  providerFramework?: ModelProviderFramework | null;
  /** Provider type fallback for callers that only know the provider. */
  providerType?: ModelProviderType | null;
  /** Compose fallback for CLI/no-provider paths. */
  agentCompose?: unknown;
}

/**
 * Resolve the final framework used for runtime dispatch and framework-specific
 * mounts. External runner payloads still call this value `cliAgentType`.
 */
export function resolveRuntimeFramework(
  params: ResolveRuntimeFrameworkParams,
): SupportedFramework {
  const framework =
    params.resolvedFramework ??
    params.providerFramework ??
    (params.providerType ? getFrameworkForType(params.providerType) : null) ??
    extractFrameworkFromCompose(params.agentCompose) ??
    undefined;

  return getValidatedFramework(framework);
}
