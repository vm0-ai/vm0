import {
  getAuthProviderSecretMetadata,
  type AuthProviderSecretMetadata,
} from "../auth-providers/secret-metadata";
import type { ModelProviderAuthProvider } from "../auth-providers/provider-types";
import type { OAuthRefreshResult, ProviderEnv } from "./provider-types";
import { codexOauthProvider } from "./providers/codex-oauth-provider";

export const MODEL_PROVIDER_OAUTH_PROVIDER_KEYS = [
  "codex-oauth-token",
] as const;

export type ModelProviderOAuthProviderKey =
  (typeof MODEL_PROVIDER_OAUTH_PROVIDER_KEYS)[number];

type ModelProviderOAuthProviderMap = {
  readonly [Key in ModelProviderOAuthProviderKey]: ModelProviderAuthProvider;
};

const MODEL_PROVIDER_OAUTH_PROVIDERS = {
  "codex-oauth-token": codexOauthProvider,
} as const satisfies ModelProviderOAuthProviderMap;

export type ModelProviderOAuthSecretMetadata = AuthProviderSecretMetadata;

export function isModelProviderOAuthProviderKey(
  providerKey: string,
): providerKey is ModelProviderOAuthProviderKey {
  return Object.hasOwn(MODEL_PROVIDER_OAUTH_PROVIDERS, providerKey);
}

export function getModelProviderOAuthSecretMetadata(
  providerKey: ModelProviderOAuthProviderKey,
): ModelProviderOAuthSecretMetadata;
export function getModelProviderOAuthSecretMetadata(
  providerKey: string,
): ModelProviderOAuthSecretMetadata | undefined;
export function getModelProviderOAuthSecretMetadata(
  providerKey: string,
): ModelProviderOAuthSecretMetadata | undefined {
  if (!isModelProviderOAuthProviderKey(providerKey)) {
    return undefined;
  }

  return getAuthProviderSecretMetadata(
    MODEL_PROVIDER_OAUTH_PROVIDERS[providerKey],
  );
}

export function isModelProviderOAuthRefreshConfigured(args: {
  readonly providerKey: ModelProviderOAuthProviderKey;
  readonly currentEnv: ProviderEnv;
}): boolean {
  const access = MODEL_PROVIDER_OAUTH_PROVIDERS[args.providerKey].access;

  switch (access.kind) {
    case "none":
      return false;

    case "refresh-token":
      return Boolean(access.getClientId(args.currentEnv));
  }
}

export async function refreshModelProviderOAuthToken(args: {
  readonly providerKey: ModelProviderOAuthProviderKey;
  readonly currentEnv: ProviderEnv;
  readonly refreshToken: string;
}): Promise<OAuthRefreshResult> {
  const access = MODEL_PROVIDER_OAUTH_PROVIDERS[args.providerKey].access;

  switch (access.kind) {
    case "none":
      throw new Error(
        `${args.providerKey} OAuth provider does not support refresh`,
      );

    case "refresh-token": {
      const clientId = access.getClientId(args.currentEnv);
      if (!clientId) {
        throw new Error(`${args.providerKey} OAuth client ID not configured`);
      }

      return await access.refreshToken({
        clientId,
        clientSecret: access.getClientSecret(args.currentEnv),
        refreshToken: args.refreshToken,
      });
    }
  }
}
