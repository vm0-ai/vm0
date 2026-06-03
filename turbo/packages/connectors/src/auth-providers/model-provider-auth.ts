import type {
  ModelProviderAuthProvider,
  ModelProviderAuthProviderRefreshResult,
} from "./types";
import type { ProviderEnv } from "./provider-env";
import { codexOauthProvider } from "./oauth/providers/codex-oauth-provider";
import {
  getChatgptRefreshSecretName,
  getChatgptSecretName,
} from "./oauth/providers/codex-oauth";

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

export interface ModelProviderOAuthSecretMetadata {
  readonly isRefreshable: true;
  readonly inputs: {
    readonly refreshToken: string;
  };
  readonly outputs: {
    readonly accessToken: string;
    readonly refreshToken: string;
  };
  readonly refreshableSecrets: readonly string[];
}

const MODEL_PROVIDER_OAUTH_SECRET_METADATA = {
  "codex-oauth-token": {
    isRefreshable: true,
    inputs: {
      refreshToken: getChatgptRefreshSecretName(),
    },
    outputs: {
      accessToken: getChatgptSecretName(),
      refreshToken: getChatgptRefreshSecretName(),
    },
    refreshableSecrets: [getChatgptSecretName()],
  },
} as const satisfies Record<
  ModelProviderOAuthProviderKey,
  ModelProviderOAuthSecretMetadata
>;

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

  return MODEL_PROVIDER_OAUTH_SECRET_METADATA[providerKey];
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
      return Boolean(access.resolveAuthClient(args.currentEnv));
  }
}

export async function refreshModelProviderOAuthToken(args: {
  readonly providerKey: ModelProviderOAuthProviderKey;
  readonly currentEnv: ProviderEnv;
  readonly inputs: {
    readonly refreshToken: string;
  };
  readonly signal: AbortSignal;
}): Promise<ModelProviderAuthProviderRefreshResult> {
  const access = MODEL_PROVIDER_OAUTH_PROVIDERS[args.providerKey].access;

  switch (access.kind) {
    case "none":
      throw new Error(
        `${args.providerKey} OAuth provider does not support refresh`,
      );

    case "refresh-token": {
      const authClient = access.resolveAuthClient(args.currentEnv);
      if (!authClient) {
        throw new Error(`${args.providerKey} auth client not configured`);
      }

      return await access.refresh({
        authClient,
        inputs: args.inputs,
        signal: args.signal,
      });
    }
  }
}
