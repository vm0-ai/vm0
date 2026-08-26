export const MODEL_PROVIDER_WRITE_TYPE_IDS = [
  "claude-code-oauth-token",
  "anthropic-api-key",
  "openrouter-api-key",
  "deepseek",
  "vercel-ai-gateway",
  "openrouter-codex",
  "vercel-ai-gateway-codex",
  "openai-api-key",
  "codex-oauth-token",
  "azure-foundry",
  "aws-bedrock",
  "custom-anthropic-messages",
  "custom-openai-responses",
  "vm0",
] as const;

export const MODEL_PROVIDER_TYPE_IDS = [
  ...MODEL_PROVIDER_WRITE_TYPE_IDS,
  "built-in",
] as const;

export type ModelProviderWriteType =
  (typeof MODEL_PROVIDER_WRITE_TYPE_IDS)[number];
export type ModelProviderType = (typeof MODEL_PROVIDER_TYPE_IDS)[number];
export type BuiltInModelProviderType = "vm0" | "built-in";

export function isBuiltInModelProviderType(
  type: string | null | undefined,
): type is BuiltInModelProviderType {
  return type === "vm0" || type === "built-in";
}

export type ModelProviderFramework = "claude-code" | "codex";
