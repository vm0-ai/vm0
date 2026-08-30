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
  "built-in",
] as const;

/**
 * Phase D1 DB/API expand compatibility for the persisted provider discriminator.
 * Remove the legacy `vm0` request/read alias only in #28368's later contract
 * release, after #29910 is production-accepted, exact legacy writes remain zero
 * for seven days, and rollback plus supported immutable-client contexts drain.
 * Until then, requests accept the alias but normalize it before any writer.
 */
export const MODEL_PROVIDER_WRITE_INPUT_TYPE_IDS = [
  ...MODEL_PROVIDER_WRITE_TYPE_IDS,
  "vm0",
] as const;

export const MODEL_PROVIDER_TYPE_IDS = [
  ...MODEL_PROVIDER_WRITE_TYPE_IDS,
  "vm0",
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

export function normalizeModelProviderWriteType(
  type: ModelProviderType,
): ModelProviderWriteType {
  return type === "vm0" ? "built-in" : type;
}

export type ModelProviderFramework = "claude-code" | "codex";
