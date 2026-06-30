import type { ExpandedFirewallConfig } from "@vm0/connectors/firewall-types";

import type {
  ModelProviderFramework,
  ModelProviderType,
} from "./model-provider-types";

type FirewallSupportedProvider = Exclude<
  ModelProviderType,
  "aws-bedrock" | "azure-foundry" | "vm0"
>;
type LegacySingleSecretProvider = Exclude<
  FirewallSupportedProvider,
  "codex-oauth-token"
>;

interface SingleSecretFirewallProviderConfig {
  readonly framework: ModelProviderFramework;
  readonly secretName: string;
  readonly anthropicBaseUrl?: string;
  readonly openaiBaseUrl?: string;
}

export const MODEL_PROVIDER_ENV_PLACEHOLDERS = {
  // Placeholder: sk-ant-api03-{93 word/hyphen chars}AA (108 chars total)
  // Source: Semgrep regex \Bsk-ant-api03-[\w\-]{93}AA\B
  //   https://semgrep.dev/blog/2025/secrets-story-and-prefixed-secrets/
  ANTHROPIC_API_KEY:
    "sk-ant-api03-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
  // Placeholder: sk-ant-oat01-{93 word/hyphen chars}AA (108 chars total)
  // Source: same structure as API key; prefix from claude setup-token output
  //   https://github.com/anthropics/claude-code/issues/18340
  //   Example: sk-ant-oat01-xxxxx...xxxxx (1-year OAuth token)
  CLAUDE_CODE_OAUTH_TOKEN:
    "sk-ant-oat01-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA",
  // Generic bearer-token marker for Claude-compatible gateways that map
  // provider-specific secrets into ANTHROPIC_AUTH_TOKEN.
  ANTHROPIC_AUTH_TOKEN: "sk-CoffeeSafeLocalCoffeeSafeLocalCo",
  // Placeholder: sk-proj-{chars}T3BlbkFJ{chars} (typical project key shape)
  // Source: mirrors the OpenAI connector firewall placeholder shape.
  OPENAI_API_KEY:
    "sk-proj-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocaT3BlbkFJCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoca",
  // Opaque fake marker, not a JWT. Codex ChatGPT mode reads auth.json, while
  // firewall auth substitutes this marker at egress.
  CHATGPT_ACCESS_TOKEN:
    "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
  CHATGPT_ACCOUNT_ID: "ws_VM0_PLACEHOLDER_DO_NOT_TRUST",
  CHATGPT_REFRESH_TOKEN: "rt_VM0_PLACEHOLDER_DO_NOT_TRUST",
} as const;

const MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS: Record<
  LegacySingleSecretProvider,
  SingleSecretFirewallProviderConfig
> = {
  "anthropic-api-key": {
    framework: "claude-code",
    secretName: "ANTHROPIC_API_KEY",
  },
  "claude-code-oauth-token": {
    framework: "claude-code",
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
  },
  "openrouter-api-key": {
    framework: "claude-code",
    secretName: "OPENROUTER_API_KEY",
    anthropicBaseUrl: "https://openrouter.ai/api",
  },
  "moonshot-api-key": {
    framework: "claude-code",
    secretName: "MOONSHOT_API_KEY",
    anthropicBaseUrl: "https://api.moonshot.ai/anthropic",
  },
  "minimax-api-key": {
    framework: "claude-code",
    secretName: "MINIMAX_API_KEY",
    anthropicBaseUrl: "https://api.minimax.io/anthropic",
  },
  "deepseek-api-key": {
    framework: "claude-code",
    secretName: "DEEPSEEK_API_KEY",
    anthropicBaseUrl: "https://api.deepseek.com/anthropic",
  },
  "zai-api-key": {
    framework: "claude-code",
    secretName: "ZAI_API_KEY",
    anthropicBaseUrl: "https://api.z.ai/api/anthropic",
  },
  "vercel-ai-gateway": {
    framework: "claude-code",
    secretName: "VERCEL_AI_GATEWAY_API_KEY",
    anthropicBaseUrl: "https://ai-gateway.vercel.sh",
  },
  "openrouter-codex": {
    framework: "codex",
    secretName: "OPENROUTER_API_KEY",
    openaiBaseUrl: "https://openrouter.ai/api/v1",
  },
  "vercel-ai-gateway-codex": {
    framework: "codex",
    secretName: "VERCEL_AI_GATEWAY_API_KEY",
    openaiBaseUrl: "https://ai-gateway.vercel.sh/v1",
  },
  "openai-api-key": {
    framework: "codex",
    secretName: "OPENAI_API_KEY",
  },
};

const ANTHROPIC_API_BASE = "https://api.anthropic.com";

function isLegacySingleSecretProvider(
  type: FirewallSupportedProvider,
): type is LegacySingleSecretProvider {
  return type !== "codex-oauth-token";
}

function getFirewallBaseUrl(type: FirewallSupportedProvider): string {
  // codex-oauth-token targets ChatGPT's backend, not the public OpenAI API.
  if (!isLegacySingleSecretProvider(type)) {
    return "https://chatgpt.com/backend-api/codex";
  }

  const config = MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS[type];
  if (config.framework === "codex") {
    return (
      config.openaiBaseUrl?.replace(/\/+$/, "") ??
      "https://api.openai.com/v1/responses"
    );
  }

  const base = (config.anthropicBaseUrl ?? ANTHROPIC_API_BASE).replace(
    /\/+$/,
    "",
  );
  return `${base}/v1/messages`;
}

function mpFirewall(
  type: LegacySingleSecretProvider,
  authHeader: { name: string; valuePrefix?: string },
  placeholderValue: string,
): ExpandedFirewallConfig {
  const secretName = MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS[type].secretName;
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
 * Firewall gateway configs for model providers with static base URLs.
 * Used to auto-generate firewall entries that protect API tokens from sandbox exposure.
 * Excluded: aws-bedrock (dynamic region URLs + SigV4), azure-foundry (dynamic resource URLs).
 *
 * Claude Code gateway providers scope to /v1/messages so vm0-managed API keys
 * are only injected on LLM inference paths, not vendor admin endpoints.
 */
export const MODEL_PROVIDER_FIREWALL_CONFIGS = {
  "anthropic-api-key": mpFirewall(
    "anthropic-api-key",
    { name: "x-api-key" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_API_KEY,
  ),
  "claude-code-oauth-token": mpFirewall(
    "claude-code-oauth-token",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN,
  ),
  "openrouter-api-key": mpFirewall(
    "openrouter-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  ),
  "moonshot-api-key": mpFirewall(
    "moonshot-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  ),
  "minimax-api-key": mpFirewall(
    "minimax-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  ),
  "deepseek-api-key": mpFirewall(
    "deepseek-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  ),
  "zai-api-key": mpFirewall(
    "zai-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  ),
  "vercel-ai-gateway": mpFirewall(
    "vercel-ai-gateway",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.ANTHROPIC_AUTH_TOKEN,
  ),
  // Codex-framework twin of openrouter-api-key. It reuses the same stored
  // OpenRouter secret, but the sandbox env name is OPENAI_API_KEY because codex
  // SDK hits OpenAI-compatible paths (/chat/completions, /responses) under
  // https://openrouter.ai/api/v1.
  "openrouter-codex": mpFirewall(
    "openrouter-codex",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
  ),
  // Codex-framework twin of vercel-ai-gateway. It reuses the same stored Vercel
  // secret, but the sandbox env name is OPENAI_API_KEY. Base URL is scoped to
  // the /v1 prefix so codex can use either /chat/completions or /responses.
  "vercel-ai-gateway-codex": mpFirewall(
    "vercel-ai-gateway-codex",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
  ),
  "openai-api-key": mpFirewall(
    "openai-api-key",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
  ),
  // ChatGPT OAuth provider: multi-header injection plus unknown-policy auth.openai.com deny.
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
            description:
              "Access the ChatGPT Codex backend with GET and POST requests.",
            rules: ["GET /{path*}", "POST /{path*}"],
          },
        ],
      },
      {
        base: "https://auth.openai.com",
        auth: { headers: {} },
        permissions: [],
      },
    ],
    defaultPolicies: {
      // Keep the legacy name denied during rolling deploys so new API-created
      // policies still block old runner catalogs that exposed denied: ANY /*.
      deny: ["denied"],
      unknownPolicy: "deny",
    },
    placeholders: {
      CHATGPT_ACCESS_TOKEN:
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN,
      CHATGPT_ACCOUNT_ID: MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID,
      CHATGPT_REFRESH_TOKEN:
        MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN,
    },
  },
} as const satisfies Record<FirewallSupportedProvider, ExpandedFirewallConfig>;

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
