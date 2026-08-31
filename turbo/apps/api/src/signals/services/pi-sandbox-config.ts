import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import {
  getModelProviderPiChatCompletionsUrl,
  getProviderBaseUrl,
  getSecretNameForType,
  isBuiltInModelProviderType,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  isPiAgentModelSupported,
  type PiOpenAICompatibleProvider,
} from "@okouai/pi-agent-runtime";

import { isWebChatTriggerSource } from "./chat-trigger-source.service";

/**
 * Resolve non-secret model metadata shared by the sandbox Pi runtime and the
 * required API first-turn slot. Credentials remain in the ordinary encrypted
 * run context and are never embedded in this launch metadata.
 */

function piDefaultBaseUrl(concreteType: string): string | undefined {
  const providerType = concreteType as ModelProviderType;
  if (providerType === "deepseek") {
    return getProviderBaseUrl(providerType) ?? undefined;
  }
  const chatCompletionsUrl = getModelProviderPiChatCompletionsUrl(providerType);
  return chatCompletionsUrl?.replace(/chat\/completions$/, "");
}

function isPiSandboxCompatibleProviderType(type: string): boolean {
  return (
    type === "codex-oauth-token" ||
    type === "openrouter-codex" ||
    type === "vercel-ai-gateway-codex" ||
    piDefaultBaseUrl(type) !== undefined
  );
}

function piProvider(concreteType: string): PiOpenAICompatibleProvider | null {
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
    case "vercel-ai-gateway-codex": {
      return "vercel-ai-gateway";
    }
    case "codex-oauth-token": {
      return "codex";
    }
    default: {
      return null;
    }
  }
}

function piCredentialSecretName(concreteType: string): string | null {
  if (concreteType === "codex-oauth-token") {
    return "CHATGPT_ACCESS_TOKEN";
  }
  return getSecretNameForType(concreteType as ModelProviderType) ?? null;
}

export function shouldUsePiExecution(args: {
  readonly chatThreadId: string | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | undefined;
  readonly triggerSource: TriggerSource;
  readonly featureSwitchContext: FeatureSwitchContext;
}): boolean {
  const isPiModel =
    args.selectedModel === "deepseek-v4-flash" ||
    args.selectedModel === "deepseek-v4-pro";
  return (
    args.chatThreadId !== undefined &&
    isWebChatTriggerSource(args.triggerSource) &&
    isBuiltInModelProviderType(args.modelProviderType) &&
    isPiModel &&
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
): PiModelConfig | null {
  if (!provider || !provider.selectedModel || provider.inlineFirewall) {
    return null;
  }
  const concreteType = provider.concreteType ?? provider.type;
  const providerId = piProvider(concreteType);
  const credentialSecretName = piCredentialSecretName(concreteType);
  if (
    !isPiSandboxCompatibleProviderType(concreteType) ||
    !providerId ||
    !credentialSecretName
  ) {
    return null;
  }
  const baseUrl =
    provider.environment.OPENAI_BASE_URL ?? piDefaultBaseUrl(concreteType);
  const model =
    provider.environment.OPENAI_MODEL ??
    provider.environment.ANTHROPIC_MODEL ??
    provider.selectedModel;
  if (!baseUrl || !model) {
    return null;
  }

  const apiKeyEnv =
    providerId === "moonshotai"
      ? "ANTHROPIC_AUTH_TOKEN"
      : providerId === "codex"
        ? "CHATGPT_ACCESS_TOKEN"
        : "OPENAI_API_KEY";
  const config = {
    provider: providerId,
    baseUrl,
    model,
    apiKeyEnv,
    credentialSecretName,
  } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: "sandbox-secret",
  })
    ? config
    : null;
}
