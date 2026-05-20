import { type ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";

/**
 * Bridge: model-provider type (api-contracts) → OAuth provider key.
 *
 * The model-provider type and OAuth provider key are intentionally distinct:
 * the model-provider type names the user-facing provider (e.g., the row in
 * `model_providers.type`), while the OAuth provider key names the OAuth
 * implementation in `MODEL_PROVIDER_OAUTH_PROVIDERS` that knows how to refresh
 * its tokens.
 *
 * Add an entry when a new model-provider OAuth type ships its provider.
 *
 * Paired with OAUTH_PROVIDER_KEY_SOURCE_TYPE and OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE
 * below — the bridge-table-consistency test asserts the inversion.
 */
export const MODEL_PROVIDER_OAUTH_PROVIDER_KEY: Partial<
  Record<ModelProviderType, string>
> = {
  "codex-oauth-token": "codex-oauth-token",
};

/**
 * Reverse of MODEL_PROVIDER_OAUTH_PROVIDER_KEY. When the firewall webhook sees a
 * provider key in this table, it dispatches refresh against the model-provider
 * source (different secrets `type`, different metadata table) instead of the
 * default connector source.
 */
export const OAUTH_PROVIDER_KEY_SOURCE_TYPE: Record<string, "model-provider"> =
  {
    "codex-oauth-token": "model-provider",
  };

/**
 * Inverse of MODEL_PROVIDER_OAUTH_PROVIDER_KEY: OAuth provider key → model-provider type.
 * Used by the refresh-persistence path to update the right `model_providers`
 * row by `type` column.
 */
export const OAUTH_PROVIDER_KEY_TO_MODEL_PROVIDER_TYPE: Record<
  string,
  ModelProviderType
> = {
  "codex-oauth-token": "codex-oauth-token",
};

/**
 * Resolve the secret source for an OAuth provider key.
 * Returns "model-provider" for providers that back model-provider OAuth types,
 * "connector" for everything else (the default).
 */
export function getOAuthProviderKeySourceType(
  providerKey: string,
): "connector" | "model-provider" {
  return OAUTH_PROVIDER_KEY_SOURCE_TYPE[providerKey] ?? "connector";
}
