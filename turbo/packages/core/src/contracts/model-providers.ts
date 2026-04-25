import { z } from "zod";

import { FeatureSwitchKey } from "../feature-switch-key";
import type { ExpandedFirewallConfig } from "./firewalls";

/**
 * Secret field configuration for multi-secret providers
 */
export interface SecretFieldConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
}

/**
 * Auth method configuration for providers with multiple auth options
 */
export interface AuthMethodConfig {
  label: string;
  helpText?: string;
  secrets: Record<string, SecretFieldConfig>;
}

/**
 * The org slug authorized to use the VM0 managed provider.
 */
export const VM0_ORG_SLUG = "vm0";

/**
 * Mapping from VM0 managed model names to their concrete provider type and vendor.
 * Used at build-context time to resolve the meta-provider to a real provider.
 *
 * NOTE: Defined before MODEL_PROVIDER_TYPES so the vm0 entry can derive its
 * models list from this mapping via Object.keys().
 */
interface Vm0ModelConfig {
  concreteType: string;
  vendor: string;
  // Overrides the display-name when substituting `$model` in the concrete
  // provider's environment mapping. Needed when the upstream API expects a
  // different identifier than what we show to users (e.g. OpenRouter uses
  // "z-ai/glm-5.1" while our UI shows "glm-5.1").
  apiModel?: string;
  featureFlag?: FeatureSwitchKey;
}

// Key order is load-bearing: `Object.keys()` preserves insertion order and
// `MODEL_PROVIDER_TYPES.vm0.models` is derived from it, which in turn drives
// the order models appear in the Built-in model dropdown.
export const VM0_MODEL_TO_PROVIDER: Record<string, Vm0ModelConfig> = {
  "claude-opus-4-7": {
    concreteType: "anthropic-api-key",
    vendor: "anthropic",
  },
  "claude-opus-4-6": {
    concreteType: "anthropic-api-key",
    vendor: "anthropic",
  },
  "claude-sonnet-4-6": {
    concreteType: "anthropic-api-key",
    vendor: "anthropic",
  },
  "glm-5.1": {
    concreteType: "openrouter-api-key",
    vendor: "openrouter",
    apiModel: "z-ai/glm-5.1",
  },
  "claude-haiku-4-5": {
    concreteType: "anthropic-api-key",
    vendor: "anthropic",
  },
  "kimi-k2.6": {
    concreteType: "moonshot-api-key",
    vendor: "moonshot",
  },
  "kimi-k2.5": {
    concreteType: "moonshot-api-key",
    vendor: "moonshot",
  },
  "MiniMax-M2.7": {
    concreteType: "minimax-api-key",
    vendor: "minimax",
  },
  "deepseek-v4-pro": {
    concreteType: "deepseek-api-key",
    vendor: "deepseek",
  },
  "deepseek-v4-flash": {
    concreteType: "deepseek-api-key",
    vendor: "deepseek",
  },
};

/**
 * Return the VM0 managed models visible to the caller, filtered by feature
 * switches. Models without a featureFlag are always visible; models with a
 * flag require the flag to be enabled in the supplied feature map.
 */
export function getVm0VisibleModels(
  features?: Partial<Record<FeatureSwitchKey, boolean>>,
): string[] {
  return Object.entries(VM0_MODEL_TO_PROVIDER)
    .filter(([, { featureFlag }]) => {
      if (!featureFlag) return true;
      return features?.[featureFlag] === true;
    })
    .map(([model]) => {
      return model;
    });
}

/**
 * Model Provider type configuration
 * Maps type to framework, secret name, and display info
 *
 * For providers with `environmentMapping`, the secret is mapped to framework variables:
 * - `$secret` → the stored secret value (legacy single secret)
 * - `$secrets.X` → lookup secret X from the secrets map (multi-secret)
 * - `$model` → the selected model (or default)
 * - Other values are passed through as literals
 *
 * Provider types:
 * - Legacy providers: use `secretName` for single secret
 * - Multi-auth providers: use `authMethods` for multiple auth options with different secrets
 */
export const MODEL_PROVIDER_TYPES = {
  "claude-code-oauth-token": {
    framework: "claude-code" as const,
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code (OAuth Token)",
    secretLabel: "OAuth token",
    helpText:
      "To get your OAuth token, run: claude setup-token\n(Requires Claude Pro or Max subscription)",
    environmentMapping: {
      CLAUDE_CODE_OAUTH_TOKEN: "$secret",
      ANTHROPIC_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
    ] as string[],
    defaultModel: "claude-sonnet-4-6",
  },
  "anthropic-api-key": {
    framework: "claude-code" as const,
    secretName: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    secretLabel: "API key",
    helpText:
      "Get your API key at: https://console.anthropic.com/settings/keys",
    environmentMapping: {
      ANTHROPIC_API_KEY: "$secret",
      ANTHROPIC_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "claude-opus-4-7",
    ] as string[],
    defaultModel: "claude-sonnet-4-6",
  },
  "openrouter-api-key": {
    framework: "claude-code" as const,
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    secretLabel: "API key",
    helpText: "Get your API key at: https://openrouter.ai/settings/keys",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "anthropic/claude-opus-4.7",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-haiku-4.5",
      "z-ai/glm-5.1",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.5",
      "minimax/minimax-m2.7",
    ] as string[],
    defaultModel: "",
  },
  "moonshot-api-key": {
    framework: "claude-code" as const,
    secretName: "MOONSHOT_API_KEY",
    label: "Moonshot (Kimi)",
    secretLabel: "API key",
    helpText:
      "Get your API key at: https://platform.moonshot.ai/console/api-keys",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "kimi-k2.6",
      "kimi-k2.5",
      "kimi-k2-thinking-turbo",
      "kimi-k2-thinking",
    ] as string[],
    defaultModel: "kimi-k2.6",
  },
  "minimax-api-key": {
    framework: "claude-code" as const,
    secretName: "MINIMAX_API_KEY",
    label: "MiniMax",
    secretLabel: "API key",
    helpText:
      "Get your API key at: https://platform.minimax.io/user-center/basic-information/interface-key",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    } as Record<string, string>,
    models: ["MiniMax-M2.7", "MiniMax-M2.1"] as string[],
    defaultModel: "MiniMax-M2.7",
  },
  "deepseek-api-key": {
    framework: "claude-code" as const,
    secretName: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    secretLabel: "API key",
    helpText: "Get your API key at: https://platform.deepseek.com/api_keys",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
      API_TIMEOUT_MS: "600000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    } as Record<string, string>,
    models: ["deepseek-v4-pro", "deepseek-v4-flash"] as string[],
    defaultModel: "deepseek-v4-flash",
  },
  "zai-api-key": {
    framework: "claude-code" as const,
    secretName: "ZAI_API_KEY",
    label: "Z.AI (GLM)",
    secretLabel: "API key",
    helpText: "Get your API key at: https://z.ai/model-api",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
      API_TIMEOUT_MS: "3000000",
    } as Record<string, string>,
    models: ["glm-5.1", "glm-5", "glm-4.7", "glm-4.5-air"] as string[],
    defaultModel: "glm-5.1",
  },
  "vercel-ai-gateway": {
    framework: "claude-code" as const,
    secretName: "VERCEL_AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
    secretLabel: "API key",
    helpText: "Get your API key from the Vercel AI Gateway dashboard",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$secret",
      ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-haiku-4.5",
      "moonshotai/kimi-k2.6",
      "moonshotai/kimi-k2.5",
      "minimax/minimax-m2.5",
      "zai/glm-5-turbo",
    ] as string[],
    defaultModel: "anthropic/claude-sonnet-4.6",
  },
  "azure-foundry": {
    framework: "claude-code" as const,
    label: "Azure Foundry",
    helpText:
      "Run Claude on Microsoft Azure Foundry.\nSetup guide: https://code.claude.com/docs/en/microsoft-foundry",
    authMethods: {
      "api-key": {
        label: "API Key",
        helpText: "Use an Azure Foundry API key for authentication",
        secrets: {
          ANTHROPIC_FOUNDRY_API_KEY: {
            label: "ANTHROPIC_FOUNDRY_API_KEY",
            required: true,
            helpText: "API key from Azure Foundry portal (Endpoints and keys)",
          },
          ANTHROPIC_FOUNDRY_RESOURCE: {
            label: "ANTHROPIC_FOUNDRY_RESOURCE",
            required: true,
            placeholder: "my-resource",
            helpText: "Azure resource name (from portal URL)",
          },
        },
      },
    } as Record<string, AuthMethodConfig>,
    defaultAuthMethod: "api-key",
    environmentMapping: {
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_API_KEY: "$secrets.ANTHROPIC_FOUNDRY_API_KEY",
      ANTHROPIC_FOUNDRY_RESOURCE: "$secrets.ANTHROPIC_FOUNDRY_RESOURCE",
      ANTHROPIC_MODEL: "$model",
    } as Record<string, string>,
    models: [] as string[],
    defaultModel: "",
    allowCustomModel: true,
    customModelPlaceholder: "claude-sonnet-4-5",
  },
  "aws-bedrock": {
    framework: "claude-code" as const,
    label: "AWS Bedrock",
    helpText:
      "Run Claude on AWS Bedrock.\nSetup guide: https://code.claude.com/docs/en/amazon-bedrock",
    authMethods: {
      "api-key": {
        label: "Bedrock API Key",
        helpText: "Use a Bedrock API key for authentication",
        secrets: {
          AWS_BEARER_TOKEN_BEDROCK: {
            label: "AWS_BEARER_TOKEN_BEDROCK",
            required: true,
            helpText: "Bedrock API key from AWS console",
          },
          AWS_REGION: {
            label: "AWS_REGION",
            required: true,
            placeholder: "us-east-1",
            helpText: "e.g., us-east-1, us-west-2",
          },
        },
      },
      "access-keys": {
        label: "IAM Access Keys",
        helpText: "Use IAM access key secrets",
        secrets: {
          AWS_ACCESS_KEY_ID: {
            label: "AWS_ACCESS_KEY_ID",
            required: true,
            helpText: "IAM access key ID",
          },
          AWS_SECRET_ACCESS_KEY: {
            label: "AWS_SECRET_ACCESS_KEY",
            required: true,
            helpText: "IAM secret access key",
          },
          AWS_SESSION_TOKEN: {
            label: "AWS_SESSION_TOKEN",
            required: false,
            helpText: "Optional, for temporary secrets",
          },
          AWS_REGION: {
            label: "AWS_REGION",
            required: true,
            placeholder: "us-east-1",
            helpText: "e.g., us-east-1, us-west-2",
          },
        },
      },
    } as Record<string, AuthMethodConfig>,
    defaultAuthMethod: "api-key",
    environmentMapping: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "$secrets.AWS_REGION",
      AWS_BEARER_TOKEN_BEDROCK: "$secrets.AWS_BEARER_TOKEN_BEDROCK",
      AWS_ACCESS_KEY_ID: "$secrets.AWS_ACCESS_KEY_ID",
      AWS_SECRET_ACCESS_KEY: "$secrets.AWS_SECRET_ACCESS_KEY",
      AWS_SESSION_TOKEN: "$secrets.AWS_SESSION_TOKEN",
      ANTHROPIC_MODEL: "$model",
    } as Record<string, string>,
    models: [] as string[],
    defaultModel: "",
    allowCustomModel: true,
    customModelPlaceholder: "anthropic.claude-sonnet-4-20250514-v1:0",
  },
  vm0: {
    framework: "claude-code" as const,
    label: "VM0 Managed",
    models: Object.keys(VM0_MODEL_TO_PROVIDER) as string[],
    defaultModel: "claude-sonnet-4-6",
  },
} as const;

export type ModelProviderType = keyof typeof MODEL_PROVIDER_TYPES;
export type ModelProviderFramework = "claude-code";

/**
 * Provider types hidden from user-facing selection UI.
 * These lack static firewall support (dynamic URLs or SigV4), so token
 * replacement cannot be used.  New selection is blocked until a proper
 * solution is implemented; existing configurations continue to work.
 */
const HIDDEN_PROVIDER_LIST = ["aws-bedrock", "azure-foundry"] as const;
type HiddenProviderType = (typeof HIDDEN_PROVIDER_LIST)[number];

const HIDDEN_PROVIDER_TYPES: ReadonlySet<ModelProviderType> = new Set(
  HIDDEN_PROVIDER_LIST,
);

/**
 * Provider type that supports firewall (has a static base URL and secretName).
 * Excludes hidden providers (dynamic URLs / SigV4) and vm0 (meta-provider).
 * Adding a new provider without a firewall config entry will cause a compile error.
 */
type FirewallSupportedProvider = Exclude<
  ModelProviderType,
  HiddenProviderType | "vm0"
>;

/**
 * Get provider types available for user selection.
 * Excludes providers that are hidden from the UI (e.g., those without token replacement support).
 */
export function getSelectableProviderTypes(): ModelProviderType[] {
  return (Object.keys(MODEL_PROVIDER_TYPES) as ModelProviderType[]).filter(
    (type) => {
      return !HIDDEN_PROVIDER_TYPES.has(type);
    },
  );
}

/**
 * Firewall gateway configs for model providers with static base URLs.
 * Used to auto-generate firewall entries that protect API tokens from sandbox exposure.
 * Excluded: aws-bedrock (dynamic region URLs + SigV4), azure-foundry (dynamic resource URLs).
 *
 * getFirewallBaseUrl() appends /v1/messages to every provider's base URL so the
 * vm0-managed API key is only injected on LLM inference paths — not on vendor admin
 * endpoints (/v1/organizations, /v1/credits, etc.). The prefix covers every endpoint
 * Claude Code actually hits per Anthropic's LLM gateway requirements (/v1/messages
 * and /v1/messages/count_tokens). See #9560.
 */
const ANTHROPIC_API_BASE = "https://api.anthropic.com";

function getFirewallBaseUrl(type: ModelProviderType): string {
  const base = (
    getEnvironmentMapping(type)?.ANTHROPIC_BASE_URL ?? ANTHROPIC_API_BASE
  ).replace(/\/+$/, "");
  return `${base}/v1/messages`;
}

/**
 * Build a firewall config for a model provider.
 *
 * The secret name is derived from MODEL_PROVIDER_TYPES[type].secretName
 * (single source of truth), so callers never specify it — eliminating
 * any possibility of mismatch between auth header templates and placeholders.
 */
function mpFirewall(
  type: FirewallSupportedProvider,
  authHeader: { name: string; valuePrefix?: string },
  placeholderValue: string,
): ExpandedFirewallConfig {
  const secretName = MODEL_PROVIDER_TYPES[type].secretName;
  const secretRef = `\${{ secrets.${secretName} }}`;
  const headerValue = authHeader.valuePrefix
    ? `${authHeader.valuePrefix} ${secretRef}`
    : secretRef;
  return {
    name: `model-provider:${type}`,
    apis: [
      {
        base: getFirewallBaseUrl(type),
        auth: { headers: { [authHeader.name]: headerValue } },
        permissions: [],
      },
    ],
    placeholders: { [secretName]: placeholderValue },
  };
}

/**
 * Every FirewallSupportedProvider must have an entry here.
 * Adding a new provider without a firewall config will cause a type error.
 */
export const MODEL_PROVIDER_FIREWALL_CONFIGS: Record<
  FirewallSupportedProvider,
  ExpandedFirewallConfig
> = {
  // Placeholder: sk-ant-api03-{93 word/hyphen chars}AA (108 chars total)
  // Source: Semgrep regex \Bsk-ant-api03-[\w\-]{93}AA\B
  //   https://semgrep.dev/blog/2025/secrets-story-and-prefixed-secrets/
  "anthropic-api-key": mpFirewall(
    "anthropic-api-key",
    { name: "x-api-key" },
    "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
  ),
  // Placeholder: sk-ant-oat01-{93 word/hyphen chars}AA (108 chars total)
  // Source: same structure as API key; prefix from claude setup-token output
  //   https://github.com/anthropics/claude-code/issues/18340
  //   Example: sk-ant-oat01-xxxxx...xxxxx (1-year OAuth token)
  "claude-code-oauth-token": mpFirewall(
    "claude-code-oauth-token",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-ant-oat01-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
  ),
  // Placeholder: sk-or-v1-{64 hex chars} (73 chars total)
  // Source: real key observed in GitHub issue
  //   https://github.com/continuedev/continue/issues/6191
  //   Example: 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
  "openrouter-api-key": mpFirewall(
    "openrouter-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    "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",
  ),
  // Placeholder: sk-{32 chars} (35 chars total)
  // Source: no authoritative format documentation found; using generic sk- prefix
  "moonshot-api-key": mpFirewall(
    "moonshot-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-CoffeeSafeLocalCoffeeSafeLocalCo",
  ),
  // Placeholder: eyJ... (JWT-style, variable length)
  // Source: no authoritative format documentation found; MiniMax docs do not disclose key format
  //   https://platform.minimax.io/docs/api-reference/api-overview
  "minimax-api-key": mpFirewall(
    "minimax-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    "eyCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffe",
  ),
  // Placeholder: sk-{32 hex chars} (35 chars total)
  // Source: Semgrep regex \bsk-[a-f0-9]{32}\b
  //   https://semgrep.dev/blog/2025/secrets-story-and-prefixed-secrets/
  "deepseek-api-key": mpFirewall(
    "deepseek-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-c0ffee5afe10ca1c0ffee5afe10ca1c0",
  ),
  // Placeholder: sk-{32 chars} (35 chars total)
  // Source: no authoritative format documentation found; using generic sk- prefix
  "zai-api-key": mpFirewall(
    "zai-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-CoffeeSafeLocalCoffeeSafeLocalCo",
  ),
  // Placeholder: sk-{32 chars} (35 chars total)
  // Source: no authoritative format documentation found; Vercel gateway proxies upstream providers
  "vercel-ai-gateway": mpFirewall(
    "vercel-ai-gateway",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-CoffeeSafeLocalCoffeeSafeLocalCo",
  ),
};

/**
 * Get firewall gateway config for a model provider type.
 * Returns undefined for providers without static base URLs (aws-bedrock, azure-foundry).
 */
function isFirewallSupported(
  type: ModelProviderType,
): type is FirewallSupportedProvider {
  return type in MODEL_PROVIDER_FIREWALL_CONFIGS;
}

export function getModelProviderFirewall(
  type: ModelProviderType,
): ExpandedFirewallConfig | undefined {
  return isFirewallSupported(type)
    ? MODEL_PROVIDER_FIREWALL_CONFIGS[type]
    : undefined;
}

export const modelProviderTypeSchema = z.enum([
  "claude-code-oauth-token",
  "anthropic-api-key",
  "openrouter-api-key",
  "moonshot-api-key",
  "minimax-api-key",
  "deepseek-api-key",
  "zai-api-key",
  "vercel-ai-gateway",
  "azure-foundry",
  "aws-bedrock",
  "vm0",
]);

export const modelProviderFrameworkSchema = z.enum(["claude-code"]);

/**
 * Get the concrete provider type for a VM0 managed model.
 * Throws if the model is not in the VM0 model mapping.
 */
export function getVm0ConcreteProviderType(model: string): ModelProviderType {
  const entry = VM0_MODEL_TO_PROVIDER[model];
  if (!entry) {
    throw new Error(
      `Unknown VM0 model "${model}". Valid models: ${Object.keys(VM0_MODEL_TO_PROVIDER).join(", ")}`,
    );
  }
  return entry.concreteType as ModelProviderType;
}

/**
 * Get the vendor name for a VM0 managed model.
 * Used for key pool lookup.
 */
export function getVm0Vendor(model: string): string {
  const entry = VM0_MODEL_TO_PROVIDER[model];
  if (!entry) {
    throw new Error(
      `Unknown VM0 model "${model}". Valid models: ${Object.keys(VM0_MODEL_TO_PROVIDER).join(", ")}`,
    );
  }
  return entry.vendor;
}

/**
 * Get the upstream API model identifier for a VM0 managed model.
 * Falls back to the display name when no override is configured.
 */
export function getVm0ApiModel(model: string): string {
  const entry = VM0_MODEL_TO_PROVIDER[model];
  if (!entry) {
    throw new Error(
      `Unknown VM0 model "${model}". Valid models: ${Object.keys(VM0_MODEL_TO_PROVIDER).join(", ")}`,
    );
  }
  return entry.apiModel ?? model;
}

/**
 * Get framework for a model provider type
 */
export function getFrameworkForType(
  type: ModelProviderType,
): ModelProviderFramework {
  return MODEL_PROVIDER_TYPES[type]?.framework ?? "claude-code";
}

/**
 * Get secret name for a model provider type (legacy single-secret providers)
 * Returns undefined for multi-auth providers
 */
export function getSecretNameForType(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return undefined;
  return "secretName" in config ? config.secretName : undefined;
}

/**
 * Check if a model provider type has multiple auth methods
 */
export function hasAuthMethods(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return false;
  return "authMethods" in config;
}

/**
 * Get auth methods for a model provider type
 * Returns undefined for legacy single-secret providers
 */
export function getAuthMethodsForType(
  type: ModelProviderType,
): Record<string, AuthMethodConfig> | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!config) return undefined;
  return "authMethods" in config ? config.authMethods : undefined;
}

/**
 * Get default auth method for a model provider type
 * Returns undefined for legacy single-secret providers
 */
export function getDefaultAuthMethod(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "defaultAuthMethod" in config ? config.defaultAuthMethod : undefined;
}

/**
 * Get secrets config for a specific auth method
 * Returns undefined if provider doesn't have auth methods or auth method doesn't exist
 */
export function getSecretsForAuthMethod(
  type: ModelProviderType,
  authMethod: string,
): Record<string, SecretFieldConfig> | undefined {
  const authMethods = getAuthMethodsForType(type);
  if (!authMethods || !(authMethod in authMethods)) {
    return undefined;
  }
  const method = authMethods[authMethod];
  return method?.secrets;
}

/**
 * Get secret names for a specific auth method
 * Returns array of secret names required for the auth method
 */
export function getSecretNamesForAuthMethod(
  type: ModelProviderType,
  authMethod: string,
): string[] | undefined {
  const secrets = getSecretsForAuthMethod(type, authMethod);
  if (!secrets) {
    return undefined;
  }
  return Object.keys(secrets);
}

/**
 * Get environment mapping for a model provider type
 * Returns undefined for providers without mapping (use secret directly)
 */
export function getEnvironmentMapping(
  type: ModelProviderType,
): Record<string, string> | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "environmentMapping" in config ? config.environmentMapping : undefined;
}

/**
 * Get the ANTHROPIC_BASE_URL for a model provider type.
 * Returns null for Anthropic-native providers (no base URL override).
 */
export function getProviderBaseUrl(type: ModelProviderType): string | null {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!("environmentMapping" in config)) return null;
  const url = config.environmentMapping["ANTHROPIC_BASE_URL"];
  return url ?? null;
}

/**
 * Check if two model providers are compatible for session continuation.
 * Providers are compatible if they resolve to the same ANTHROPIC_BASE_URL.
 */
export function areProvidersCompatible(
  a: ModelProviderType,
  b: ModelProviderType,
): boolean {
  return getProviderBaseUrl(a) === getProviderBaseUrl(b);
}

/**
 * Get available models for a model provider type
 * Returns undefined for providers without model selection
 */
export function getModels(type: ModelProviderType): string[] | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "models" in config ? config.models : undefined;
}

/**
 * Get default model for a model provider type
 * Returns undefined for providers without model selection
 */
export function getDefaultModel(type: ModelProviderType): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "defaultModel" in config ? config.defaultModel : undefined;
}

/**
 * Check if a model provider type supports model selection
 */
export function hasModelSelection(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  // Has predefined models OR allows custom model input
  return (
    ("models" in config && config.models.length > 0) ||
    ("allowCustomModel" in config && config.allowCustomModel === true)
  );
}

/**
 * Check if a model provider allows custom model input
 */
export function allowsCustomModel(type: ModelProviderType): boolean {
  const config = MODEL_PROVIDER_TYPES[type];
  return "allowCustomModel" in config && config.allowCustomModel === true;
}

/**
 * Get custom model placeholder for a model provider type
 */
export function getCustomModelPlaceholder(
  type: ModelProviderType,
): string | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "customModelPlaceholder" in config
    ? config.customModelPlaceholder
    : undefined;
}

/**
 * Model provider response
 */
export const modelProviderResponseSchema = z.object({
  id: z.uuid(),
  type: modelProviderTypeSchema,
  framework: modelProviderFrameworkSchema,
  secretName: z.string().nullable(), // Legacy single-secret (deprecated for multi-auth)
  authMethod: z.string().nullable(), // For multi-auth providers
  secretNames: z.array(z.string()).nullable(), // For multi-auth providers
  isDefault: z.boolean(),
  selectedModel: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ModelProviderResponse = z.infer<typeof modelProviderResponseSchema>;

/**
 * List model providers response
 */
export const modelProviderListResponseSchema = z.object({
  modelProviders: z.array(modelProviderResponseSchema),
});

export type ModelProviderListResponse = z.infer<
  typeof modelProviderListResponseSchema
>;

/**
 * Create/update model provider request
 *
 * Legacy providers use `secret` (single string)
 * Multi-auth providers use `authMethod` + `secrets` (map)
 */
export const upsertModelProviderRequestSchema = z.object({
  type: modelProviderTypeSchema,
  secret: z.string().min(1).optional(), // Legacy single secret
  authMethod: z.string().optional(), // For multi-auth providers
  secrets: z.record(z.string(), z.string()).optional(), // For multi-auth providers
  selectedModel: z.string().optional(),
});

export type UpsertModelProviderRequest = z.infer<
  typeof upsertModelProviderRequestSchema
>;

/**
 * Upsert response includes created flag
 */
export const upsertModelProviderResponseSchema = z.object({
  provider: modelProviderResponseSchema,
  created: z.boolean(),
});

export type UpsertModelProviderResponse = z.infer<
  typeof upsertModelProviderResponseSchema
>;

/**
 * Update model request schema
 */
export const updateModelRequestSchema = z.object({
  selectedModel: z.string().optional(),
});

export type UpdateModelRequest = z.infer<typeof updateModelRequestSchema>;
