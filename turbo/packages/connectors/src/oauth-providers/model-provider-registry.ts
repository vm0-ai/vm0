import type {
  OAuthAuthorizationCodeProvider,
  OAuthRefreshProvider,
} from "./provider-types";
import { codexOauthHandler } from "./providers/codex-oauth-handler";

export const MODEL_PROVIDER_OAUTH_PROVIDERS = {
  "codex-oauth-token": codexOauthHandler,
} as const satisfies Record<
  string,
  OAuthAuthorizationCodeProvider | OAuthRefreshProvider
>;

export type ModelProviderOAuthProviderKey =
  keyof typeof MODEL_PROVIDER_OAUTH_PROVIDERS;

export type ModelProviderOAuthProvider =
  (typeof MODEL_PROVIDER_OAUTH_PROVIDERS)[ModelProviderOAuthProviderKey];

export function isModelProviderOAuthProviderKey(
  providerKey: string,
): providerKey is ModelProviderOAuthProviderKey {
  return Object.hasOwn(MODEL_PROVIDER_OAUTH_PROVIDERS, providerKey);
}

export function getModelProviderOAuthProvider(
  providerKey: string,
): ModelProviderOAuthProvider | undefined {
  if (!isModelProviderOAuthProviderKey(providerKey)) {
    return undefined;
  }
  return MODEL_PROVIDER_OAUTH_PROVIDERS[providerKey];
}
