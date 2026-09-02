import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
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

function piRuntimeContract(args: {
  readonly providerType: string;
  readonly selectedModel: string;
  readonly codexServiceTier: "fast" | undefined;
}): PiRuntimeContract {
  if (
    isBuiltInModelProviderType(args.providerType) &&
    args.selectedModel === "gpt-5.6-terra"
  ) {
    return {
      api: "openai-responses",
      thinkingLevel: "low",
      ...(args.codexServiceTier === "fast"
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
  const isExistingPiModel =
    args.selectedModel === "deepseek-v4-flash" ||
    args.selectedModel === "deepseek-v4-pro";
  const isStandardTerra =
    args.selectedModel === "gpt-5.6-terra" &&
    args.codexServiceTier === undefined;
  const isFastTerra =
    args.selectedModel === "gpt-5.6-terra" &&
    args.codexServiceTier === "fast" &&
    (args.builtInModelRuntimeRoute?.providerType === "openai-api-key" ||
      args.builtInModelRuntimeRoute?.providerType === "openrouter-codex") &&
    isFeatureEnabled(FeatureSwitchKey.CodexFastMode, args.featureSwitchContext);
  return (
    args.chatThreadId !== undefined &&
    isWebChatTriggerSource(args.triggerSource) &&
    isBuiltInModelProviderType(args.modelProviderType) &&
    (isExistingPiModel || isStandardTerra || isFastTerra) &&
    isFeatureEnabled(FeatureSwitchKey.PiLoop, args.featureSwitchContext)
  );
}

export function resolvePiSandboxModelConfig(
  provider: {
    readonly type: string;
    readonly concreteType?: string;
    readonly environment: Record<string, string>;
    readonly selectedModel: string | null;
    readonly inlineFirewall?: boolean;
  } | null,
  codexServiceTier: "fast" | undefined = undefined,
): PiModelConfig | null {
  if (!provider || !provider.selectedModel || provider.inlineFirewall) {
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
