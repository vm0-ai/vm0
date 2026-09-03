import type { PiModelConfigLegacy as PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  getModelProviderPiEndpoint,
  getSecretNameForType,
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isPiAgentModelSupported } from "@okouai/pi-agent-runtime";

import type { BuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import { isWebChatTriggerSource } from "./chat-trigger-source.service";
import { GATEWAY_RUNTIME_SECRET_NAME } from "./model-provider-gateway-runtime";

/**
 * Resolve non-secret model metadata shared by the sandbox Pi runtime and the
 * required API first-turn slot. Credentials remain in the ordinary encrypted
 * run context and are never embedded in this launch metadata.
 */

function normalizedBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

interface PiRuntimeContract {
  readonly api: "openai-responses";
  readonly thinkingLevel?: PiModelConfig["thinkingLevel"];
  readonly serviceTier?: PiModelConfig["serviceTier"];
}

type PiCatalogProvider = "deepseek" | "openai";

function piCatalogProvider(
  selectedModel: string | null | undefined,
): PiCatalogProvider | null {
  switch (selectedModel) {
    case "deepseek-v4-flash":
    case "deepseek-v4-pro": {
      return "deepseek";
    }
    case "gpt-5.6-terra": {
      return "openai";
    }
    default: {
      return null;
    }
  }
}

function piRuntimeContract(args: {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly codexServiceTier: "fast" | undefined;
}): PiRuntimeContract {
  if (args.selectedModel === "gpt-5.6-terra") {
    return {
      api: "openai-responses",
      thinkingLevel: "low",
      ...(isBuiltInModelProviderType(args.providerType) &&
      args.codexServiceTier === "fast"
        ? { serviceTier: "priority" as const }
        : {}),
    };
  }
  return { api: "openai-responses" };
}

function piProvider(
  concreteType: ModelProviderType,
): "deepseek" | "openai" | "openrouter" | null {
  switch (concreteType) {
    case "deepseek": {
      return "deepseek";
    }
    case "openai-api-key": {
      return "openai";
    }
    case "openrouter-codex": {
      return "openrouter";
    }
    default: {
      return null;
    }
  }
}

export function shouldUsePiExecution(args: {
  readonly chatThreadId: string | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
  readonly builtInModelRuntimeRoute: BuiltInModelRuntimeRoute | undefined;
  readonly triggerSource: TriggerSource;
  readonly featureSwitchContext: FeatureSwitchContext;
}): boolean {
  const catalogProvider = piCatalogProvider(args.selectedModel);
  const isExistingPiModel = catalogProvider === "deepseek";
  const isStandardTerra =
    catalogProvider === "openai" && args.codexServiceTier === undefined;
  const isFastTerra =
    catalogProvider === "openai" &&
    args.codexServiceTier === "fast" &&
    isBuiltInModelProviderType(args.modelProviderType) &&
    (args.builtInModelRuntimeRoute?.providerType === "openai-api-key" ||
      args.builtInModelRuntimeRoute?.providerType === "openrouter-codex") &&
    isFeatureEnabled(FeatureSwitchKey.CodexFastMode, args.featureSwitchContext);
  const isPiModelProvider =
    isBuiltInModelProviderType(args.modelProviderType) ||
    args.modelProviderType === "custom-openai-responses";
  return (
    args.chatThreadId !== undefined &&
    isWebChatTriggerSource(args.triggerSource) &&
    isPiModelProvider &&
    (isExistingPiModel || isStandardTerra || isFastTerra) &&
    isFeatureEnabled(FeatureSwitchKey.PiLoop, args.featureSwitchContext)
  );
}

interface PiModelProviderConfigInput {
  readonly type: string;
  readonly concreteType?: string;
  readonly environment: Record<string, string>;
  readonly selectedModel: string | null;
  readonly inlineFirewall?: boolean;
  readonly credentialHeader?: PiModelConfig["credentialHeader"];
}

function resolveCustomGatewayPiModelConfig(
  provider: PiModelProviderConfigInput,
  codexServiceTier: "fast" | undefined,
): PiModelConfig | null {
  if (
    provider.type !== "custom-openai-responses" ||
    provider.inlineFirewall !== true ||
    !provider.selectedModel ||
    !provider.credentialHeader
  ) {
    return null;
  }
  const catalogProvider = piCatalogProvider(provider.selectedModel);
  const baseUrl = provider.environment.OPENAI_BASE_URL;
  const model = provider.environment.OPENAI_MODEL;
  if (!catalogProvider || !baseUrl || !model) {
    return null;
  }
  const runtimeContract = piRuntimeContract({
    providerType: provider.type,
    selectedModel: provider.selectedModel,
    codexServiceTier,
  });
  const config = {
    provider: catalogProvider,
    baseUrl,
    model,
    catalogModel: provider.selectedModel,
    apiKeyEnv: "OPENAI_API_KEY",
    credentialSecretName: GATEWAY_RUNTIME_SECRET_NAME,
    credentialHeader: provider.credentialHeader,
    ...runtimeContract,
  } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    catalogModel: config.catalogModel,
    apiKey: "sandbox-secret",
    ...runtimeContract,
  })
    ? config
    : null;
}

export function resolvePiSandboxModelConfig(
  provider: PiModelProviderConfigInput | null,
  codexServiceTier: "fast" | undefined = undefined,
): PiModelConfig | null {
  if (!provider || !provider.selectedModel) {
    return null;
  }
  if (provider.type === "custom-openai-responses") {
    return resolveCustomGatewayPiModelConfig(provider, codexServiceTier);
  }
  if (provider.inlineFirewall) {
    return null;
  }
  const concreteType = modelProviderTypeSchema.safeParse(
    provider.concreteType ?? provider.type,
  );
  if (!concreteType.success) {
    return null;
  }
  const providerId = piProvider(concreteType.data);
  const credentialSecretName = getSecretNameForType(concreteType.data);
  if (!providerId || !credentialSecretName) {
    return null;
  }
  const model = provider.environment.OPENAI_MODEL ?? provider.selectedModel;
  if (!model) {
    return null;
  }
  const endpoint = getModelProviderPiEndpoint(
    concreteType.data,
    "openai-responses",
  );
  if (!endpoint) {
    return null;
  }
  const configuredBaseUrl = provider.environment.OPENAI_BASE_URL;
  if (
    configuredBaseUrl &&
    normalizedBaseUrl(configuredBaseUrl) !== normalizedBaseUrl(endpoint.baseUrl)
  ) {
    return null;
  }

  const apiKeyEnv = "OPENAI_API_KEY";
  const runtimeContract = piRuntimeContract({
    providerType: provider.type,
    selectedModel: provider.selectedModel,
    codexServiceTier,
  });
  const config = {
    provider: providerId,
    baseUrl: endpoint.baseUrl,
    model,
    apiKeyEnv,
    credentialSecretName,
    ...runtimeContract,
  } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: "sandbox-secret",
    ...runtimeContract,
  })
    ? config
    : null;
}
