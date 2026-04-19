import {
  MODEL_PROVIDER_TYPES,
  getSecretNameForType,
  hasAuthMethods,
  type ModelProviderType,
  type SecretFieldConfig,
} from "@vm0/core";

/**
 * Provider dialog shape: determines which dialog UI to render
 *
 * - "oauth": OAuth token flow (e.g. claude-code-oauth-token)
 * - "multi-auth": Multiple auth methods with secret fields (e.g. aws-bedrock)
 * - "no-secret": No credentials needed (e.g. vm0 managed provider)
 * - "api-key": Single API key input (default for legacy providers)
 */
type ProviderShape = "oauth" | "api-key" | "multi-auth" | "no-secret";

export function getProviderShape(type: ModelProviderType): ProviderShape {
  if (type === "claude-code-oauth-token") {
    return "oauth";
  }
  if (hasAuthMethods(type)) {
    return "multi-auth";
  }
  if (!getSecretNameForType(type)) {
    return "no-secret";
  }
  return "api-key";
}

/**
 * UI-only display overrides for provider labels, descriptions, and secret fields.
 * These do NOT modify the core contracts — only how the platform UI renders them.
 */

interface ProviderUIOverrides {
  label?: string;
  description?: string;
  defaultModel?: string;
  secretFieldOverrides?: Record<string, Partial<SecretFieldConfig>>;
  authMethodLabelOverrides?: Record<string, string>;
}

function getOverrides(
  type: ModelProviderType,
): ProviderUIOverrides | undefined {
  if (type === "claude-code-oauth-token") {
    return {
      label: "Claude Code (OAuth token)",
      description:
        "Leverage Claude Code's exceptional intelligence to build and run agents.",
    };
  }
  if (type === "anthropic-api-key") {
    return {
      label: "Anthropic API key",
      description:
        "Power your agents with Claude models for advanced reasoning and analysis.",
    };
  }
  if (type === "openrouter-api-key") {
    return {
      description:
        "Route to 200+ models from multiple providers through unified interface.",
      defaultModel: "anthropic/claude-sonnet-4.5",
    };
  }
  if (type === "moonshot-api-key") {
    return {
      description:
        "Process extensive context with up to 200k tokens for complex workflows.",
    };
  }
  if (type === "minimax-api-key") {
    return {
      description:
        "Generate multimodal content including text, images, and voice.",
    };
  }
  if (type === "zai-api-key") {
    return {
      description:
        "Access Zhipu AI's ChatGLM models with excellent performance at competitive pricing.",
    };
  }
  if (type === "deepseek-api-key") {
    return {
      label: "Deepseek",
      description:
        "Execute deep reasoning and analytical tasks with cost-effective performance.",
    };
  }
  if (type === "vercel-ai-gateway") {
    return {
      description:
        "Access Claude models through Vercel AI Gateway with a unified API.",
    };
  }
  if (type === "azure-foundry") {
    return {
      label: "Azure foundry portal",
      description:
        "Deploy enterprise-grade AI with Azure security and compliance.",
      authMethodLabelOverrides: { "api-key": "API key" },
      secretFieldOverrides: {
        ANTHROPIC_FOUNDRY_API_KEY: {
          label: "Anthropic foundry API key",
          placeholder: "API key from Azure Foundry portal",
        },
        ANTHROPIC_FOUNDRY_RESOURCE: {
          label: "Anthropic foundry resource",
          placeholder: "Enter Anthropic foundry resource",
        },
      },
    };
  }
  if (type === "vm0") {
    return {
      label: "Built-in model",
      description:
        "Powered by Claude — uses your VM0 credits. No API key needed.",
    };
  }
  if (type === "aws-bedrock") {
    return {
      description:
        "Scale foundation models with AWS enterprise security and infrastructure.",
      authMethodLabelOverrides: {
        "api-key": "Bedrock API key",
        "access-keys": "IAM access keys",
      },
      secretFieldOverrides: {
        AWS_BEARER_TOKEN_BEDROCK: {
          label: "Bedrock API key",
          placeholder: "Bedrock API key from AWS console",
        },
        AWS_REGION: {
          label: "AWS region",
          placeholder: "e.g., us-east-1, us-west-2",
        },
        AWS_ACCESS_KEY_ID: {
          label: "AWS access key ID",
          placeholder: "IAM access key ID",
        },
        AWS_SECRET_ACCESS_KEY: {
          label: "AWS secret access key",
          placeholder: "IAM secret access key",
        },
        AWS_SESSION_TOKEN: {
          label: "AWS session token",
          placeholder: "Optional, for temporary secrets",
        },
      },
    };
  }
  return undefined;
}

/**
 * Get the display label for a provider type (UI override or core fallback)
 */
export function getUILabel(type: ModelProviderType): string {
  return getOverrides(type)?.label ?? MODEL_PROVIDER_TYPES[type].label;
}

/**
 * Get the description for a provider type (UI-only, undefined if none)
 */
export function getUIDescription(type: ModelProviderType): string | undefined {
  return getOverrides(type)?.description;
}

/**
 * Get the default model override (UI-only, undefined if none)
 */
export function getUIDefaultModel(type: ModelProviderType): string | undefined {
  return getOverrides(type)?.defaultModel;
}

/**
 * Get UI-overridden secret field config. Merges UI overrides on top of core config.
 */
export function getUISecretField(
  type: ModelProviderType,
  secretKey: string,
  coreConfig: SecretFieldConfig,
): SecretFieldConfig {
  const overrides = getOverrides(type)?.secretFieldOverrides?.[secretKey];
  if (!overrides) {
    return coreConfig;
  }
  return { ...coreConfig, ...overrides };
}

/**
 * Get UI-overridden auth method label
 */
export function getUIAuthMethodLabel(
  type: ModelProviderType,
  authMethodKey: string,
  coreLabel: string,
): string {
  return (
    getOverrides(type)?.authMethodLabelOverrides?.[authMethodKey] ?? coreLabel
  );
}

/**
 * Human-readable display names for model IDs across all providers.
 * Falls back to the raw model ID if no mapping is found.
 */
const MODEL_DISPLAY_NAMES = Object.freeze<Record<string, string>>({
  // Anthropic direct (claude-code-oauth-token, anthropic-api-key, vm0)
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  // Anthropic via OpenRouter / Vercel AI Gateway
  "anthropic/claude-sonnet-4.6": "Claude Sonnet 4.6",
  "anthropic/claude-opus-4.6": "Claude Opus 4.6",
  "anthropic/claude-sonnet-4.5": "Claude Sonnet 4.5",
  "anthropic/claude-opus-4.5": "Claude Opus 4.5",
  "anthropic/claude-haiku-4.5": "Claude Haiku 4.5",
  // DeepSeek
  "deepseek-chat": "DeepSeek Chat",
  // MiniMax
  "MiniMax-M2.7": "MiniMax M2.7",
  "MiniMax-M2.1": "MiniMax M2.1",
  "minimax/minimax-m2.5": "MiniMax M2.5",
  // Kimi / Moonshot
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2-thinking": "Kimi K2 Thinking",
  "kimi-k2-thinking-turbo": "Kimi K2 Thinking Turbo",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  // GLM / ZhipuAI
  "glm-5.1": "GLM-5.1",
  "glm-5": "GLM-5",
  "glm-4.7": "GLM-4.7",
  "glm-4.5-air": "GLM-4.5 Air",
  "zai/glm-5-turbo": "GLM-5 Turbo",
});

/**
 * Get a human-readable display name for a model ID.
 * Returns the raw model ID if no friendly name is defined.
 */
export function getModelDisplayName(model: string): string {
  return MODEL_DISPLAY_NAMES[model] ?? model;
}
