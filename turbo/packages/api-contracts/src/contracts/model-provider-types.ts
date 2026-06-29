export const MODEL_PROVIDER_TYPE_IDS = [
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
] as const;

export type ModelProviderType = (typeof MODEL_PROVIDER_TYPE_IDS)[number];

export type ModelProviderFramework = "claude-code" | "codex";
