import type { ExpandedFirewallConfig } from "@okouai/connectors/firewall-types";

import type {
  ModelProviderFramework,
  ModelProviderType,
} from "./model-provider-types";

// Custom gateway types are excluded because their firewall is compiled per
// surface from the stored base URL and auth header, not from a static table.
type FirewallSupportedProvider = Exclude<
  ModelProviderType,
  | "aws-bedrock"
  | "azure-foundry"
  | "custom-anthropic-messages"
  | "custom-openai-responses"
  | "vm0"
  | "built-in"
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
  readonly firewallBaseUrl?: string;
  /**
   * Chat-completions endpoint used by the in-sandbox Pi agent loop.
   *
   * The firewall injects the real key only for bases it lists, and `base`
   * matching is a prefix match. The Codex-era bases above point at
   * `/responses`, which does not prefix `/chat/completions`, so a Pi sandbox
   * turn would forward the placeholder verbatim and be rejected upstream.
   * Listing the exact inference path keeps injection scoped: it does not widen
   * to vendor admin endpoints on the same host.
   */
  readonly piChatCompletionsUrl?: string;
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
  deepseek: {
    framework: "codex",
    secretName: "DEEPSEEK_API_KEY",
    openaiBaseUrl: "https://api.deepseek.com/",
    firewallBaseUrl: "https://api.deepseek.com/responses",
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
    piChatCompletionsUrl: "https://api.openai.com/v1/chat/completions",
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
  if (config.firewallBaseUrl) {
    return config.firewallBaseUrl;
  }
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
  const auth = { headers: { [authHeader.name]: headerValue } };
  const piChatCompletionsUrl =
    MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS[type].piChatCompletionsUrl;
  return {
    name: `model-provider:${type}`,
    apis: [
      { base: getFirewallBaseUrl(type), auth, permissions: [] },
      ...(piChatCompletionsUrl === undefined
        ? []
        : [{ base: piChatCompletionsUrl, auth, permissions: [] }]),
    ],
    placeholders: { [secretName]: placeholderValue },
  };
}

/**
 * Firewall gateway configs for model providers with static base URLs.
 * Used to auto-generate firewall entries that protect API tokens from sandbox exposure.
 * Excluded: aws-bedrock (dynamic region URLs + SigV4), azure-foundry (dynamic resource URLs).
 *
 * Claude Code gateway providers scope to /v1/messages so vm0-built-in API keys
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
  deepseek: mpFirewall(
    "deepseek",
    { name: "Authorization", valuePrefix: "Bearer" },
    MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
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

/**
 * Chat-completions URL the in-sandbox Pi agent loop calls for a provider, or
 * undefined when the provider is not Pi-capable. `pi-sandbox-config` derives the
 * Pi base URL from this same table so the firewall rule and the runtime call
 * cannot drift apart.
 */
export function getModelProviderPiChatCompletionsUrl(
  type: ModelProviderType,
): string | undefined {
  const config = (
    MODEL_PROVIDER_FIREWALL_PROVIDER_CONFIGS as Partial<
      Record<ModelProviderType, SingleSecretFirewallProviderConfig>
    >
  )[type];
  if (config?.piChatCompletionsUrl !== undefined) {
    return config.piChatCompletionsUrl;
  }
  // Codex subscription (codex-oauth-token) is a multi-secret provider, so it
  // lives outside the single-secret table above. The Pi runtime calls
  // `${base}/codex/responses`, which is prefix-covered by the firewall base
  // `https://chatgpt.com/backend-api/codex` (see MODEL_PROVIDER_FIREWALL_CONFIGS),
  // so this base and that rule cannot drift apart.
  if (type === "codex-oauth-token") {
    return "https://chatgpt.com/backend-api";
  }
  return undefined;
}

export function getModelProviderFirewall(
  type: ModelProviderType,
): ExpandedFirewallConfig | undefined {
  return isFirewallSupported(type)
    ? MODEL_PROVIDER_FIREWALL_CONFIGS[type]
    : undefined;
}
