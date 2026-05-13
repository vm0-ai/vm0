import {
  MODEL_PROVIDER_TYPES,
  getSecretNameForType,
  hasAuthMethods,
  type ModelProviderType,
  type SecretFieldConfig,
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
  if (type === "codex-oauth-token") {
    return {
      description:
        "Sign in with your ChatGPT subscription (Plus / Pro / Business / Edu / Enterprise). Workspace selection happens on auth.openai.com.",
    };
  }
  if (type === "anthropic-api-key") {
    return {
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
 * Credit multiplier for Built-in model offerings, normalized so Claude Sonnet 4.6 = 1x.
 * Sourced from OpenRouter per-token USD pricing and normalized via a blended
 * (input + 5× output) cost against Sonnet 4.6 ($3/$15 per M), rounded to 1
 * decimal. Only applies to the `vm0` provider type; BYOK providers pay the
 * vendor directly and do not carry a platform multiplier.
 */
const VM0_MODEL_CREDIT_MULTIPLIER = Object.freeze<Record<string, number>>({
  "claude-opus-4-6": 1.7,
  "claude-opus-4-7": 1.7,
  "claude-sonnet-4-6": 1,
  "glm-5.1": 0.4,
  "claude-haiku-4-5": 0.3,
  "kimi-k2.6": 0.3,
  "deepseek-v4-pro": 0.06,
  "kimi-k2.5": 0.2,
  "MiniMax-M2.7": 0.1,
  "deepseek-v4-flash": 0.02,
});

export function getVm0ModelMultiplier(model: string): number | undefined {
  return VM0_MODEL_CREDIT_MULTIPLIER[model];
}
