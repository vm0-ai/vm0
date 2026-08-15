import type { PiModelConfig } from "@okouai/api-contracts/contracts/runners";
import {
  getModelProviderPiChatCompletionsUrl,
  getProviderBaseUrl,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isPiAgentModelSupported,
  type PiOpenAICompatibleProvider,
} from "@okouai/pi-agent-runtime";

/**
 * Resolve the non-secret model metadata consumed by the sandbox-only Pi
 * runtime. Provider credentials continue through the ordinary runner secret
 * environment and never enter the API execution path.
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
  if (!isPiSandboxCompatibleProviderType(concreteType) || !providerId) {
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
  const config = { provider: providerId, baseUrl, model, apiKeyEnv } as const;
  return isPiAgentModelSupported({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    apiKey: "sandbox-secret",
  })
    ? config
    : null;
}
