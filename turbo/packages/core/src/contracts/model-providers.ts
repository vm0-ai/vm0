import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Model Provider type configuration
 * Maps type to framework, credential name, and display info
 *
 * For providers with `environmentMapping`, the credential is mapped to framework variables:
 * - `$credential` → the stored credential value
 * - `$model` → the selected model (or default)
 * - Other values are passed through as literals
 */
export const MODEL_PROVIDER_TYPES = {
  "claude-code-oauth-token": {
    framework: "claude-code" as const,
    credentialName: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code (OAuth Token)",
    credentialLabel: "OAuth token",
    helpText:
      "To get your OAuth token, run: claude setup-token\n(Requires Claude Pro or Max subscription)",
  },
  "anthropic-api-key": {
    framework: "claude-code" as const,
    credentialName: "ANTHROPIC_API_KEY",
    label: "Anthropic API Key",
    credentialLabel: "API key",
    helpText:
      "Get your API key at: https://console.anthropic.com/settings/keys",
  },
  "openrouter-api-key": {
    framework: "claude-code" as const,
    credentialName: "OPENROUTER_API_KEY",
    label: "OpenRouter API Key",
    credentialLabel: "API key",
    helpText: "Get your API key at: https://openrouter.ai/settings/keys",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$credential",
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-opus-4.5",
      "anthropic/claude-haiku-4.5",
    ] as string[],
    defaultModel: "",
  },
  "moonshot-api-key": {
    framework: "claude-code" as const,
    credentialName: "MOONSHOT_API_KEY",
    label: "Moonshot API Key (Kimi)",
    credentialLabel: "API key",
    helpText:
      "Get your API key at: https://platform.moonshot.ai/console/api-keys",
    environmentMapping: {
      ANTHROPIC_AUTH_TOKEN: "$credential",
      ANTHROPIC_BASE_URL: "https://api.moonshot.ai/anthropic",
      ANTHROPIC_MODEL: "$model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "$model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "$model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "$model",
      CLAUDE_CODE_SUBAGENT_MODEL: "$model",
    } as Record<string, string>,
    models: [
      "kimi-k2.5",
      "kimi-k2-thinking-turbo",
      "kimi-k2-thinking",
    ] as string[],
    defaultModel: "kimi-k2.5",
  },
} as const;

export type ModelProviderType = keyof typeof MODEL_PROVIDER_TYPES;
export type ModelProviderFramework = "claude-code" | "codex";

export const modelProviderTypeSchema = z.enum([
  "claude-code-oauth-token",
  "anthropic-api-key",
  "openrouter-api-key",
  "moonshot-api-key",
]);

export const modelProviderFrameworkSchema = z.enum(["claude-code", "codex"]);

/**
 * Get framework for a model provider type
 */
export function getFrameworkForType(
  type: ModelProviderType,
): ModelProviderFramework {
  return MODEL_PROVIDER_TYPES[type].framework;
}

/**
 * Get credential name for a model provider type
 */
export function getCredentialNameForType(type: ModelProviderType): string {
  return MODEL_PROVIDER_TYPES[type].credentialName;
}

/**
 * Get environment mapping for a model provider type
 * Returns undefined for providers without mapping (use credential directly)
 */
export function getEnvironmentMapping(
  type: ModelProviderType,
): Record<string, string> | undefined {
  const config = MODEL_PROVIDER_TYPES[type];
  return "environmentMapping" in config ? config.environmentMapping : undefined;
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
  return "models" in config && config.models.length > 0;
}

/**
 * Model provider response
 */
export const modelProviderResponseSchema = z.object({
  id: z.string().uuid(),
  type: modelProviderTypeSchema,
  framework: modelProviderFrameworkSchema,
  credentialName: z.string(),
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
 */
export const upsertModelProviderRequestSchema = z.object({
  type: modelProviderTypeSchema,
  credential: z.string().min(1, "Credential is required"),
  convert: z.boolean().optional(),
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
 * Check for existing credential response
 */
export const checkCredentialResponseSchema = z.object({
  exists: z.boolean(),
  credentialName: z.string(),
  currentType: z.enum(["user", "model-provider"]).optional(),
});

export type CheckCredentialResponse = z.infer<
  typeof checkCredentialResponseSchema
>;

/**
 * Model providers main contract for /api/model-providers
 */
export const modelProvidersMainContract = c.router({
  list: {
    method: "GET",
    path: "/api/model-providers",
    headers: authHeadersSchema,
    responses: {
      200: modelProviderListResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List all model providers",
  },
  upsert: {
    method: "PUT",
    path: "/api/model-providers",
    headers: authHeadersSchema,
    body: upsertModelProviderRequestSchema,
    responses: {
      200: upsertModelProviderResponseSchema,
      201: upsertModelProviderResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create or update a model provider",
  },
});

export type ModelProvidersMainContract = typeof modelProvidersMainContract;

/**
 * Check credential contract for /api/model-providers/check/[type]
 */
export const modelProvidersCheckContract = c.router({
  check: {
    method: "GET",
    path: "/api/model-providers/check/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    responses: {
      200: checkCredentialResponseSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Check if credential exists for a model provider type",
  },
});

export type ModelProvidersCheckContract = typeof modelProvidersCheckContract;

/**
 * Model providers by type contract for /api/model-providers/[type]
 */
export const modelProvidersByTypeContract = c.router({
  delete: {
    method: "DELETE",
    path: "/api/model-providers/:type",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a model provider",
  },
});

export type ModelProvidersByTypeContract = typeof modelProvidersByTypeContract;

/**
 * Convert credential contract for /api/model-providers/[type]/convert
 */
export const modelProvidersConvertContract = c.router({
  convert: {
    method: "POST",
    path: "/api/model-providers/:type/convert",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    body: z.undefined(),
    responses: {
      200: modelProviderResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Convert existing user credential to model provider",
  },
});

export type ModelProvidersConvertContract =
  typeof modelProvidersConvertContract;

/**
 * Set default contract for /api/model-providers/[type]/set-default
 */
export const modelProvidersSetDefaultContract = c.router({
  setDefault: {
    method: "POST",
    path: "/api/model-providers/:type/set-default",
    headers: authHeadersSchema,
    pathParams: z.object({
      type: modelProviderTypeSchema,
    }),
    body: z.undefined(),
    responses: {
      200: modelProviderResponseSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Set a model provider as default for its framework",
  },
});

export type ModelProvidersSetDefaultContract =
  typeof modelProvidersSetDefaultContract;
