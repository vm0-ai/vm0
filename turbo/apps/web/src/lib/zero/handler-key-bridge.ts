import { type ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";

/**
 * Bridge: model-provider type (api-contracts) → connector handler key (PROVIDER_HANDLERS).
 *
 * The model-provider type and connector handler key are intentionally distinct:
 * the model-provider type names the user-facing provider (e.g., the row in
 * `model_providers.type`), while the connector handler key names the OAuth
 * implementation in `PROVIDER_HANDLERS` that knows how to refresh its tokens.
 *
 * Add an entry when a new model-provider OAuth type ships its handler.
 *
 * Paired with HANDLER_KEY_SOURCE_TYPE and SOURCE_HANDLER_TO_PROVIDER_TYPE
 * below — the bridge-table-consistency test asserts the inversion.
 */
export const MODEL_PROVIDER_HANDLER_KEY: Partial<
  Record<ModelProviderType, string>
> = {
  "codex-oauth-token": "codex-oauth",
};

/**
 * Reverse of MODEL_PROVIDER_HANDLER_KEY. When the firewall webhook sees a
 * handler key in this table, it dispatches refresh against the model-provider
 * source (different secrets `type`, different metadata table) instead of the
 * default connector source.
 */
export const HANDLER_KEY_SOURCE_TYPE: Record<string, "model-provider"> = {
  "codex-oauth": "model-provider",
};

/**
 * Inverse of MODEL_PROVIDER_HANDLER_KEY: handler key → model-provider type.
 * Used by the refresh-persistence path to update the right `model_providers`
 * row by `type` column.
 */
export const SOURCE_HANDLER_TO_PROVIDER_TYPE: Record<
  string,
  ModelProviderType
> = {
  "codex-oauth": "codex-oauth-token",
};

/**
 * Resolve the secret source for a connector handler key.
 * Returns "model-provider" for handlers that back model-provider OAuth types,
 * "connector" for everything else (the default).
 */
export function getRefreshSourceType(
  handlerKey: string,
): "connector" | "model-provider" {
  return HANDLER_KEY_SOURCE_TYPE[handlerKey] ?? "connector";
}
