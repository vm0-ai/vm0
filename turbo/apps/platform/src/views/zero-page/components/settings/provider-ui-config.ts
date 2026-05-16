import {
  MODEL_PROVIDER_TYPES,
  getVm0ModelMultiplier,
  getSecretNameForType,
  hasAuthMethods,
  type ModelProviderType,
  type SecretFieldConfig,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";

/**
 * Provider dialog shape: determines which dialog UI to render
 *
 * - "oauth": OAuth token flow (e.g. claude-code-oauth-token)
 * - "multi-auth": Multiple auth methods with secret fields (e.g. aws-bedrock)
 * - "no-secret": No credentials needed (e.g. vm0 managed provider)
 * - "api-key": Single API key input
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

const PROVIDER_UI_OVERRIDES = Object.freeze<
  Partial<Record<ModelProviderType, ProviderUIOverrides>>
>({
  "claude-code-oauth-token": {
    label: "Claude Code (OAuth token)",
    description:
      "Leverage Claude Code's exceptional intelligence to build and run agents.",
  },
  "codex-oauth-token": {
    description:
      "Sign in with your ChatGPT subscription (Plus / Pro / Business / Edu / Enterprise). Workspace selection happens on auth.openai.com.",
  },
  "anthropic-api-key": {
    description:
      "Power your agents with Claude models for advanced reasoning and analysis.",
  },
  "openrouter-api-key": {
    description:
      "Route to 200+ models from multiple providers through unified interface.",
    defaultModel: "anthropic/claude-sonnet-4.5",
  },
  "moonshot-api-key": {
    description:
      "Process extensive context with up to 200k tokens for complex workflows.",
  },
  "minimax-api-key": {
    description:
      "Generate multimodal content including text, images, and voice.",
  },
  "zai-api-key": {
    description:
      "Access Zhipu AI's ChatGLM models with excellent performance at competitive pricing.",
  },
  "deepseek-api-key": {
    label: "Deepseek",
    description:
      "Execute deep reasoning and analytical tasks with cost-effective performance.",
  },
  "vercel-ai-gateway": {
    description:
      "Access Claude models through Vercel AI Gateway with a unified API.",
  },
  "openrouter-codex": {
    description: "Route GPT models through OpenRouter for codex-style agents.",
    defaultModel: "openai/gpt-5.5",
  },
  "vercel-ai-gateway-codex": {
    description:
      "Route GPT models through Vercel AI Gateway for codex-style agents.",
  },
  "azure-foundry": {
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
  },
  vm0: {
    label: "Built-in model",
    description:
      "Powered by Claude — uses your VM0 credits. No API key needed.",
  },
  "aws-bedrock": {
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
  },
});

function getOverrides(
  type: ModelProviderType,
): ProviderUIOverrides | undefined {
  return PROVIDER_UI_OVERRIDES[type];
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

const MODEL_BRAND_ICON: Readonly<Record<SupportedRunModel, ModelProviderType>> =
  Object.freeze({
    "claude-opus-4-7": "anthropic-api-key",
    "claude-opus-4-6": "anthropic-api-key",
    "claude-sonnet-4-6": "anthropic-api-key",
    "claude-haiku-4-5": "anthropic-api-key",
    "deepseek-v4-pro": "deepseek-api-key",
    "deepseek-v4-flash": "deepseek-api-key",
    "kimi-k2.6": "moonshot-api-key",
    "kimi-k2.5": "moonshot-api-key",
    "MiniMax-M2.7": "minimax-api-key",
    "glm-5.1": "zai-api-key",
    "gpt-5.5": "openai-api-key",
    "gpt-5.4": "openai-api-key",
    "gpt-5.4-mini": "openai-api-key",
  });

export function getModelBrandIconType(
  model: SupportedRunModel,
): ModelProviderType {
  return MODEL_BRAND_ICON[model];
}
export { getVm0ModelMultiplier };
