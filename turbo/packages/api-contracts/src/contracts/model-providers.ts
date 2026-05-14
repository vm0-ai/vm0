import { z } from "zod";

import type { ExpandedFirewallConfig } from "@vm0/connectors/firewall-types";

/**
 * Secret field configuration for multi-secret providers
 */
export interface SecretFieldConfig {
  label: string;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  /**
   * When true, this secret is persisted server-side and MUST NOT flow to the
   * runner/sandbox. Used for OAuth refresh tokens and ID tokens that the
   * server holds for refresh + plan-type validation but the sandbox must
   * never see (per #7365). Honored by `resolveMultiAuthProviderSecrets`.
   */
  serverOnly?: boolean;
  /**
   * When true, this secret is populated by a server-side parser from another
   * secret in the same authMethod (typically a single user-input field whose
   * raw value is exploded into multiple stored fields). UI MUST NOT render an
   * input for this secret; the storage validation layer still uses it.
   *
   * Example: `codex-oauth-token` / `auth_json` — user pastes `CODEX_AUTH_JSON`,
   * server parser writes `CHATGPT_ACCESS_TOKEN` / `_REFRESH_TOKEN` /
   * `_ACCOUNT_ID` / `_ID_TOKEN`. Those four are `derived: true`.
   */
  derived?: boolean;
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
 * Canonical model-first catalog.
 */
export const SUPPORTED_RUN_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k2.6",
  "kimi-k2.5",
  "MiniMax-M2.7",
  "glm-5.1",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

export type SupportedRunModel = (typeof SUPPORTED_RUN_MODELS)[number];

export const DEFAULT_ORG_MODEL_POLICY_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "deepseek-v4-pro",
  "gpt-5.5",
] as const satisfies readonly SupportedRunModel[];

export const DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL =
  "claude-sonnet-4-6" as const satisfies SupportedRunModel;

export const supportedRunModelSchema = z.enum(SUPPORTED_RUN_MODELS);

export const modelProviderCredentialScopeSchema = z.enum(["org", "member"]);

export type ModelProviderCredentialScope = z.infer<
  typeof modelProviderCredentialScopeSchema
>;

export interface DefaultOrgModelPolicySeed {
  model: SupportedRunModel;
  isDefault: boolean;
  defaultProviderType: "vm0";
  credentialScope: "org";
  modelProviderId: null;
}

const SUPPORTED_RUN_MODEL_LABELS: Record<SupportedRunModel, string> = {
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.5": "Kimi K2.5",
  "MiniMax-M2.7": "MiniMax M2.7",
  "glm-5.1": "GLM-5.1",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
};

const SUPPORTED_RUN_MODEL_SET: ReadonlySet<string> = new Set(
  SUPPORTED_RUN_MODELS,
);

export function isSupportedRunModel(
  model: string | null | undefined,
): model is SupportedRunModel {
  return typeof model === "string" && SUPPORTED_RUN_MODEL_SET.has(model);
}

export function getCanonicalModelDisplayName(model: string): string {
  return isSupportedRunModel(model) ? SUPPORTED_RUN_MODEL_LABELS[model] : model;
}

export function getDefaultOrgModelPolicySeed(): DefaultOrgModelPolicySeed[] {
  return DEFAULT_ORG_MODEL_POLICY_MODELS.map((model) => {
    return {
      model,
      isDefault: model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      defaultProviderType: "vm0",
      credentialScope: "org",
      modelProviderId: null,
    };
  });
}

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
  "gpt-5.5": {
    concreteType: "openai-api-key",
    vendor: "openai",
  },
  "gpt-5.4": {
    concreteType: "openai-api-key",
    vendor: "openai",
  },
  "gpt-5.4-mini": {
    concreteType: "openai-api-key",
    vendor: "openai",
  },
};

export const VM0_MODEL_ALIAS_TO_MODEL = {
  "anthropic/claude-opus-4.7": "claude-opus-4-7",
  "anthropic/claude-opus-4.6": "claude-opus-4-6",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
  "z-ai/glm-5.1": "glm-5.1",
  "deepseek/deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek/deepseek-v4-flash": "deepseek-v4-flash",
  "moonshotai/kimi-k2.6": "kimi-k2.6",
  "moonshotai/kimi-k2.5": "kimi-k2.5",
  "minimax/minimax-m2.7": "MiniMax-M2.7",
} as const satisfies Record<string, keyof typeof VM0_MODEL_TO_PROVIDER>;

const VM0_MODEL_ALIAS_LOOKUP: Readonly<Record<string, string>> =
  VM0_MODEL_ALIAS_TO_MODEL;

export function normalizeVm0ModelId(model: string): string {
  return VM0_MODEL_ALIAS_LOOKUP[model] ?? model;
}

export type ModelImageInputSupport = "supported" | "unsupported" | "unknown";

const IMAGE_INPUT_SUPPORTED_MODELS = new Set([
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-4.5",
  "kimi-k2.6",
  "kimi-k2.5",
  "moonshotai/kimi-k2.6",
  "moonshotai/kimi-k2.5",
]);

const IMAGE_INPUT_UNSUPPORTED_MODELS = new Set([
  "glm-5.1",
  "glm-5",
  "glm-4.7",
  "glm-4.5-air",
  "z-ai/glm-5.1",
  "zai/glm-5-turbo",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "MiniMax-M2.7",
  "MiniMax-M2.1",
  "minimax/minimax-m2.7",
  "minimax/minimax-m2.5",
]);

export function getModelImageInputSupport(
  model: string | null | undefined,
): ModelImageInputSupport {
  if (!model) {
    return "unknown";
  }
  const normalized = normalizeVm0ModelId(model);
  if (
    IMAGE_INPUT_SUPPORTED_MODELS.has(normalized) ||
    IMAGE_INPUT_SUPPORTED_MODELS.has(model)
  ) {
    return "supported";
  }
  if (
    IMAGE_INPUT_UNSUPPORTED_MODELS.has(normalized) ||
    IMAGE_INPUT_UNSUPPORTED_MODELS.has(model)
  ) {
    return "unsupported";
  }
  return "unknown";
}

export function modelSupportsImageInput(
  model: string | null | undefined,
): boolean {
  return getModelImageInputSupport(model) === "supported";
}

/**
 * Return the VM0 managed models visible to callers.
 */
export function getVm0VisibleModels(): string[] {
  return Object.keys(VM0_MODEL_TO_PROVIDER);
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
      "anthropic/claude-opus-4.7",
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
  // Codex-framework twin of openrouter-api-key. Same upstream gateway (OpenRouter)
  // and same API key (shared secretName), but routes through OpenRouter's
  // OpenAI-compatible endpoint surface for GPT models that codex CLI requires.
  // Pairing rule: the claude-code entry serves Anthropic Messages API
  // (/v1/messages); this codex entry serves OpenAI Chat Completions / Responses
  // (/v1/chat/completions, /v1/responses) under the same /api/v1 prefix.
  "openrouter-codex": {
    framework: "codex" as const,
    secretName: "OPENROUTER_API_KEY",
    label: "OpenRouter (Codex)",
    secretLabel: "API key",
    helpText: "Get your API key at: https://openrouter.ai/settings/keys",
    environmentMapping: {
      OPENAI_API_KEY: "$secret",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENAI_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
    ] as string[],
    defaultModel: "openai/gpt-5.5",
  },
  // Codex-framework twin of vercel-ai-gateway. Vercel exposes both
  // Anthropic Messages and OpenAI Chat Completions / Responses on the same
  // base URL, distinguished by path. The claude-code entry uses /v1/messages;
  // this codex entry uses /v1/chat/completions or /v1/responses (codex CLI
  // picks the path it needs).
  "vercel-ai-gateway-codex": {
    framework: "codex" as const,
    secretName: "VERCEL_AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway (Codex)",
    secretLabel: "API key",
    helpText: "Get your API key from the Vercel AI Gateway dashboard",
    environmentMapping: {
      OPENAI_API_KEY: "$secret",
      OPENAI_BASE_URL: "https://ai-gateway.vercel.sh/v1",
      OPENAI_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
    ] as string[],
    defaultModel: "openai/gpt-5.5",
  },
  "openai-api-key": {
    framework: "codex" as const,
    secretName: "OPENAI_API_KEY",
    label: "OpenAI",
    secretLabel: "API key",
    helpText: "Get your API key at: https://platform.openai.com/api-keys",
    environmentMapping: {
      OPENAI_API_KEY: "$secret",
      OPENAI_MODEL: "$model",
    } as Record<string, string>,
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as string[],
    defaultModel: "gpt-5.5",
  },
  "codex-oauth-token": {
    framework: "codex" as const,
    label: "ChatGPT (Codex)",
    helpText:
      "Run `codex login` on your machine, then paste the resulting " +
      "~/.codex/auth.json contents to authorize ChatGPT (Plus / Pro / " +
      "Business / Edu / Enterprise) for Codex.",
    authMethods: {
      oauth: {
        label: "OpenAI OAuth",
        helpText:
          "Sign in with OpenAI to authorize ChatGPT (Plus / Pro / Business / Edu / Enterprise) for Codex.",
        secrets: {
          CHATGPT_ACCESS_TOKEN: {
            label: "CHATGPT_ACCESS_TOKEN",
            required: true,
            derived: true,
          },
          CHATGPT_REFRESH_TOKEN: {
            label: "CHATGPT_REFRESH_TOKEN",
            required: true,
            serverOnly: true,
            derived: true,
          },
          CHATGPT_ACCOUNT_ID: {
            label: "CHATGPT_ACCOUNT_ID",
            required: true,
            derived: true,
          },
          CHATGPT_ID_TOKEN: {
            label: "CHATGPT_ID_TOKEN",
            required: true,
            serverOnly: true,
            derived: true,
          },
        },
      },
      // Paste-based auth: client posts CODEX_AUTH_JSON, server parses it via
      // codex-auth-json-parser.ts and persists the four derived CHATGPT_*
      // fields. The raw blob is NEVER stored. The wire-shape secret
      // (CODEX_AUTH_JSON) is declared optional+serverOnly so the contract
      // accepts it on POST without persisting; the four CHATGPT_* fields are
      // the canonical stored secrets and the firewall layer reads from those.
      auth_json: {
        label: "Codex auth.json",
        helpText:
          "Run `codex login` locally, then paste the contents of ~/.codex/auth.json below.",
        secrets: {
          CODEX_AUTH_JSON: {
            label: "auth.json contents",
            required: false,
            serverOnly: true,
            placeholder: '{"OPENAI_API_KEY":null,"tokens":{...}}',
            helpText: "Paste the entire contents of ~/.codex/auth.json",
          },
          // CHATGPT_ACCESS_TOKEN and CHATGPT_ACCOUNT_ID reach the sandbox env
          // as placeholder values (substituted by the firewall token-replacement
          // layer at egress) — keeping them non-serverOnly preserves the
          // placeholder injection path. CHATGPT_REFRESH_TOKEN and
          // CHATGPT_ID_TOKEN stay serverOnly per the #7365 invariant.
          //
          // All four are `derived: true` — the server-side parser populates
          // them from the user-pasted CODEX_AUTH_JSON. The UI MUST NOT render
          // them as input fields (per #12024).
          CHATGPT_ACCESS_TOKEN: {
            label: "CHATGPT_ACCESS_TOKEN",
            required: true,
            derived: true,
          },
          CHATGPT_REFRESH_TOKEN: {
            label: "CHATGPT_REFRESH_TOKEN",
            required: true,
            serverOnly: true,
            derived: true,
          },
          CHATGPT_ACCOUNT_ID: {
            label: "CHATGPT_ACCOUNT_ID",
            required: true,
            derived: true,
          },
          CHATGPT_ID_TOKEN: {
            label: "CHATGPT_ID_TOKEN",
            required: true,
            serverOnly: true,
            derived: true,
          },
        },
      },
    } as Record<string, AuthMethodConfig>,
    defaultAuthMethod: "auth_json",
    environmentMapping: {
      CHATGPT_ACCESS_TOKEN: "$secrets.CHATGPT_ACCESS_TOKEN",
      CHATGPT_ACCOUNT_ID: "$secrets.CHATGPT_ACCOUNT_ID",
      OPENAI_MODEL: "$model",
    } as Record<string, string>,
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] as string[],
    defaultModel: "gpt-5.5",
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
export type ModelProviderFramework = "claude-code" | "codex";

const MODEL_FIRST_PROVIDER_COMPATIBILITY = {
  "claude-opus-4-7": [
    "vm0",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
  ],
  "claude-opus-4-6": [
    "vm0",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
  ],
  "claude-sonnet-4-6": [
    "vm0",
    "claude-code-oauth-token",
    "anthropic-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
  ],
  "claude-haiku-4-5": ["vm0", "openrouter-api-key"],
  "gpt-5.5": [
    "vm0",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "gpt-5.4": [
    "vm0",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "gpt-5.4-mini": [
    "vm0",
    "openai-api-key",
    "codex-oauth-token",
    "openrouter-codex",
    "vercel-ai-gateway-codex",
  ],
  "deepseek-v4-pro": ["vm0", "deepseek-api-key", "openrouter-api-key"],
  "deepseek-v4-flash": ["vm0", "deepseek-api-key", "openrouter-api-key"],
  "kimi-k2.6": [
    "vm0",
    "moonshot-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
  ],
  "kimi-k2.5": [
    "vm0",
    "moonshot-api-key",
    "openrouter-api-key",
    "vercel-ai-gateway",
  ],
  "MiniMax-M2.7": ["vm0", "minimax-api-key", "openrouter-api-key"],
  "glm-5.1": ["vm0", "zai-api-key", "openrouter-api-key"],
} as const satisfies Record<SupportedRunModel, readonly ModelProviderType[]>;

const PROVIDER_RUNTIME_MODEL_ALIASES: Partial<
  Record<ModelProviderType, Partial<Record<SupportedRunModel, string>>>
> = {
  "openrouter-api-key": {
    "claude-opus-4-7": "anthropic/claude-opus-4.7",
    "claude-opus-4-6": "anthropic/claude-opus-4.6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
    "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
    "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
    "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
    "kimi-k2.6": "moonshotai/kimi-k2.6",
    "kimi-k2.5": "moonshotai/kimi-k2.5",
    "MiniMax-M2.7": "minimax/minimax-m2.7",
    "glm-5.1": "z-ai/glm-5.1",
  },
  "vercel-ai-gateway": {
    "claude-opus-4-7": "anthropic/claude-opus-4.7",
    "claude-opus-4-6": "anthropic/claude-opus-4.6",
    "claude-sonnet-4-6": "anthropic/claude-sonnet-4.6",
    "kimi-k2.6": "moonshotai/kimi-k2.6",
    "kimi-k2.5": "moonshotai/kimi-k2.5",
  },
  "openrouter-codex": {
    "gpt-5.5": "openai/gpt-5.5",
    "gpt-5.4": "openai/gpt-5.4",
    "gpt-5.4-mini": "openai/gpt-5.4-mini",
  },
  "vercel-ai-gateway-codex": {
    "gpt-5.5": "openai/gpt-5.5",
    "gpt-5.4": "openai/gpt-5.4",
    "gpt-5.4-mini": "openai/gpt-5.4-mini",
  },
};

const CANONICAL_RUN_MODEL_ALIASES: Readonly<Record<string, SupportedRunModel>> =
  {
    "anthropic/claude-opus-4.7": "claude-opus-4-7",
    "anthropic/claude-opus-4.6": "claude-opus-4-6",
    "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
    "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
    "deepseek/deepseek-v4-pro": "deepseek-v4-pro",
    "deepseek/deepseek-v4-flash": "deepseek-v4-flash",
    "moonshotai/kimi-k2.6": "kimi-k2.6",
    "moonshotai/kimi-k2.5": "kimi-k2.5",
    "minimax/minimax-m2.7": "MiniMax-M2.7",
    "z-ai/glm-5.1": "glm-5.1",
  };

export function normalizeRunModelId(model: string): string {
  return CANONICAL_RUN_MODEL_ALIASES[model] ?? model;
}

export function getProvidersForModel(model: string): ModelProviderType[] {
  const canonical = normalizeRunModelId(model);
  if (!isSupportedRunModel(canonical)) {
    return [];
  }
  return [...MODEL_FIRST_PROVIDER_COMPATIBILITY[canonical]];
}

export function isModelSupportedByProvider(
  model: string,
  type: ModelProviderType,
): boolean {
  return getProvidersForModel(model).includes(type);
}

export function getProviderRuntimeModel(
  type: ModelProviderType,
  model: string,
): string {
  const canonical = normalizeRunModelId(model);
  if (!isSupportedRunModel(canonical)) {
    return model;
  }
  if (type === "vm0") {
    return VM0_MODEL_TO_PROVIDER[canonical]?.apiModel ?? canonical;
  }
  return PROVIDER_RUNTIME_MODEL_ALIASES[type]?.[canonical] ?? canonical;
}

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
  // codex-oauth-token targets ChatGPT's backend, not the public OpenAI API.
  if (type === "codex-oauth-token") {
    return "https://chatgpt.com/backend-api/codex";
  }
  // Codex framework providers split into two shapes:
  //   1. OpenAI direct (no OPENAI_BASE_URL override) — codex hits /v1/responses
  //      exclusively, so we scope the firewall tightly to that path. Admin
  //      endpoints like /v1/files stay outside the token-replacement surface.
  //   2. OpenAI-compatible gateways (openrouter-codex, vercel-ai-gateway-codex)
  //      set OPENAI_BASE_URL — these can serve /v1/chat/completions and
  //      /v1/responses interchangeably under the same /v1 prefix. We scope
  //      to that base directly so codex can use either path the gateway
  //      supports without re-listing endpoints here.
  if (getFrameworkForType(type) === "codex") {
    const overrideBase = getEnvironmentMapping(type)?.OPENAI_BASE_URL;
    if (overrideBase) {
      return overrideBase.replace(/\/+$/, "");
    }
    return "https://api.openai.com/v1/responses";
  }
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
// Helper accepts only single-secret providers — multi-auth firewall configs
// (e.g., codex-oauth-token) declare their entries inline because they need
// multiple headers and/or multiple API entries.
type LegacySingleSecretProvider = {
  [K in FirewallSupportedProvider]: (typeof MODEL_PROVIDER_TYPES)[K] extends {
    secretName: string;
  }
    ? K
    : never;
}[FirewallSupportedProvider];

function mpFirewall(
  type: LegacySingleSecretProvider,
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
  // Codex-framework twin of openrouter-api-key. Same key shape as the
  // claude-code entry; the difference is the firewall base URL — codex
  // SDK hits OpenAI-compatible paths (/chat/completions, /responses)
  // under https://openrouter.ai/api/v1, derived from the OPENAI_BASE_URL
  // mapping by getFirewallBaseUrl.
  "openrouter-codex": mpFirewall(
    "openrouter-codex",
    { name: "Authorization", valuePrefix: "Bearer" },
    "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",
  ),
  // Codex-framework twin of vercel-ai-gateway. Same placeholder format
  // (Vercel gateway proxies upstream); base URL scoped to /v1 prefix by
  // getFirewallBaseUrl so codex can use either /chat/completions or
  // /responses paths the gateway exposes.
  "vercel-ai-gateway-codex": mpFirewall(
    "vercel-ai-gateway-codex",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-CoffeeSafeLocalCoffeeSafeLocalCo",
  ),
  // Placeholder: sk-proj-{156 chars}T3BlbkFJ{156 chars} (typical project key shape)
  // Source: matches turbo/packages/connectors/src/firewalls/openai.generated.ts
  "openai-api-key": mpFirewall(
    "openai-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    "sk-proj-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocaT3BlbkFJCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoca",
  ),
  // ChatGPT OAuth provider — multi-header injection + auth.openai.com deny.
  // Sandbox holds placeholder strings; firewall replaces them with real
  // tokens at egress. The auth.openai.com entry is defense-in-depth: codex's
  // CODEX_REFRESH_TOKEN_URL_OVERRIDE already prevents in-sandbox refreshes,
  // but if codex ever ignores it, this firewall denies the egress at the
  // proxy layer.
  //
  // Placeholder values are opaque markers, NOT JWTs — codex doesn't read
  // CHATGPT_ACCESS_TOKEN from env in ChatGPT mode; it reads the real JWT
  // from ~/.codex/auth.json built by guest-agent (#11877). The placeholder
  // here only needs to be a stable, non-empty string the firewall can match
  // and substitute. Account-id placeholder still equals #11877's literal
  // since the architectural relationship across the two surfaces matters.
  "codex-oauth-token": {
    name: "model-provider:codex-oauth-token",
    apis: [
      {
        base: "https://chatgpt.com/backend-api/codex",
        auth: {
          headers: {
            Authorization: "Bearer ${{ secrets.CHATGPT_ACCESS_TOKEN }}",
            "ChatGPT-Account-ID": "${{ secrets.CHATGPT_ACCOUNT_ID }}",
          },
        },
        permissions: [
          {
            name: "codex:api",
            // Subtree-wildcard the codex backend: codex's path surface keeps
            // growing (#12099 added /responses, then /responses/compact 403'd
            // again). Method narrowing to GET/POST is the actual safety net —
            // it blocks accidental DELETE/PUT/PATCH on the user's ChatGPT
            // account if codex is ever prompt-injected. Base is already
            // locked to /backend-api/codex, so the blast radius is just
            // codex's own surface area.
            rules: ["GET /{path*}", "POST /{path*}"],
          },
        ],
      },
      {
        base: "https://auth.openai.com",
        auth: { headers: {} },
        permissions: [{ name: "denied", rules: ["ANY /*"] }],
      },
    ],
    defaultPolicies: {
      deny: ["denied"],
      unknownPolicy: "deny",
    },
    placeholders: {
      CHATGPT_ACCESS_TOKEN:
        "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
      CHATGPT_ACCOUNT_ID: "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
      // refresh_token written by guest-agent into ~/.codex/auth.json (#12077).
      // Kept in this map so the firewall can substitute it on egress if codex
      // ever tries to use it directly — defense-in-depth alongside
      // CODEX_REFRESH_TOKEN_URL_OVERRIDE which redirects refresh attempts to
      // localhost. The sandbox never gets the real refresh_token (#7365).
      CHATGPT_REFRESH_TOKEN: "rt_VM0_PLACEHOLDER_DO_NOT_TRUST",
    },
  },
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
  "openrouter-codex",
  "vercel-ai-gateway-codex",
  "openai-api-key",
  "codex-oauth-token",
  "azure-foundry",
  "aws-bedrock",
  "vm0",
]);

export const modelProviderFrameworkSchema = z.enum(["claude-code", "codex"]);

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
 * Get the upstream base URL for a model provider type.
 *
 * Returns the framework-appropriate base URL override from
 * environmentMapping — ANTHROPIC_BASE_URL for claude-code, OPENAI_BASE_URL
 * for codex. Returns null when the provider relies on the SDK's default
 * (Anthropic-native providers, OpenAI direct).
 *
 * Used by areProvidersCompatible to detect session-continuation safety
 * across provider swaps. Providers hitting the same upstream URL are
 * compatible; different URLs imply different upstreams and so a
 * potentially different request/response contract.
 */
export function getProviderBaseUrl(type: ModelProviderType): string | null {
  const config = MODEL_PROVIDER_TYPES[type];
  if (!("environmentMapping" in config)) return null;
  const anthropicUrl = config.environmentMapping["ANTHROPIC_BASE_URL"];
  if (anthropicUrl) return anthropicUrl;
  const openaiUrl = config.environmentMapping["OPENAI_BASE_URL"];
  return openaiUrl ?? null;
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
  // ChatGPT-only metadata populated by the codex-oauth-token callback.
  // Other provider types omit these. Mirrors the server-side connector
  // shape in apps/web/src/lib/zero/connector/providers/codex-oauth.ts.
  // The corresponding server route lands in #11909; declared here so the
  // platform UI does not have to bypass schema validation to read them.
  workspaceName: z.string().nullable().optional(),
  planType: z.string().nullable().optional(),
  // OAuth refresh state. `needsReconnect` flips to true when the firewall's
  // refresh attempt fails (#11921 writes this on the model_providers row).
  // `lastRefreshErrorCode` carries the typed code from `ChatgptRefreshError`
  // (e.g. `refresh_token_expired`) so the UI can render an actionable
  // re-connect message. Both fields are always emitted for OAuth-typed
  // providers; non-OAuth types default to false / null.
  needsReconnect: z.boolean(),
  lastRefreshErrorCode: z.string().nullable(),
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

export const orgModelPolicyRouteStatusSchema = z.enum([
  "valid",
  "missing_provider",
  "invalid",
]);

export type OrgModelPolicyRouteStatus = z.infer<
  typeof orgModelPolicyRouteStatusSchema
>;

export const orgModelPolicySchema = z.object({
  id: z.uuid(),
  model: supportedRunModelSchema,
  modelLabel: z.string(),
  isDefault: z.boolean(),
  defaultProviderType: modelProviderTypeSchema,
  credentialScope: modelProviderCredentialScopeSchema,
  modelProviderId: z.uuid().nullable(),
  routeStatus: orgModelPolicyRouteStatusSchema,
  routeStatusReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type OrgModelPolicy = z.infer<typeof orgModelPolicySchema>;

export const updateOrgModelPolicySchema = z.object({
  model: supportedRunModelSchema,
  isDefault: z.boolean(),
  defaultProviderType: modelProviderTypeSchema,
  credentialScope: modelProviderCredentialScopeSchema,
  modelProviderId: z.uuid().nullable(),
});

export type UpdateOrgModelPolicy = z.infer<typeof updateOrgModelPolicySchema>;

export const orgModelPoliciesResponseSchema = z.object({
  policies: z.array(orgModelPolicySchema),
  workspaceDefaultModel: supportedRunModelSchema.nullable(),
  workspaceDefaultPolicyId: z.uuid().nullable(),
});

export type OrgModelPoliciesResponse = z.infer<
  typeof orgModelPoliciesResponseSchema
>;

export const updateOrgModelPoliciesRequestSchema = z.object({
  policies: z.array(updateOrgModelPolicySchema),
});

export type UpdateOrgModelPoliciesRequest = z.infer<
  typeof updateOrgModelPoliciesRequestSchema
>;
