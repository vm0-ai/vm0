import {
  MODEL_PROVIDER_TYPES,
  hasAuthMethods,
  type ModelProviderType,
  type SecretFieldConfig,
} from "@vm0/core";

/**
 * Provider dialog shape: determines which dialog UI to render
 */
type ProviderShape = "oauth" | "api-key" | "multi-auth";

export function getProviderShape(type: ModelProviderType): ProviderShape {
  if (type === "claude-code-oauth-token") {
    return "oauth";
  }
  if (hasAuthMethods(type)) {
    return "multi-auth";
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

function multiProviderDescription(): ProviderUIOverrides {
  return {
    description:
      "Supports multiple providers and models behind a single endpoint.",
  };
}

function getOverrides(
  type: ModelProviderType,
): ProviderUIOverrides | undefined {
  if (type === "claude-code-oauth-token") {
    return {
      label: "Claude Code OAuth token",
      description: "Use your Claude Code OAuth token for agent execution.",
    };
  }
  if (type === "anthropic-api-key") {
    return {
      label: "Anthropic API key",
      description: "Use a personal Anthropic API key for direct model access.",
    };
  }
  if (type === "openrouter-api-key") {
    return {
      ...multiProviderDescription(),
      defaultModel: "anthropic/claude-sonnet-4.5",
    };
  }
  if (
    type === "moonshot-api-key" ||
    type === "minimax-api-key" ||
    type === "zai-api-key"
  ) {
    return multiProviderDescription();
  }
  if (type === "deepseek-api-key") {
    return { label: "Deepseek", ...multiProviderDescription() };
  }
  if (type === "azure-foundry") {
    return {
      label: "Azure foundry portal",
      ...multiProviderDescription(),
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
  if (type === "aws-bedrock") {
    return {
      ...multiProviderDescription(),
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
