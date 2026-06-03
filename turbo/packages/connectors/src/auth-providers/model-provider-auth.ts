import type {
  ModelProviderAuthProviderRefreshResult,
  ModelProviderRefreshTokenAuthProvider,
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

export interface ModelProviderOAuthSecretMetadata {
  readonly isRefreshable: true;
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
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

type ModelProviderOAuthSecretMetadataMap =
  typeof MODEL_PROVIDER_OAUTH_SECRET_METADATA;

type ModelProviderOAuthRefreshInputValues<
  ProviderKey extends ModelProviderOAuthProviderKey,
> = {
  readonly [InputName in keyof ModelProviderOAuthSecretMetadataMap[ProviderKey]["inputs"]]: string;
};

type ModelProviderOAuthRefreshableSecretName<
  ProviderKey extends ModelProviderOAuthProviderKey,
> = ModelProviderOAuthSecretMetadataMap[ProviderKey] extends {
  readonly refreshableSecrets: readonly (infer SecretName)[];
}
  ? Extract<SecretName, string>
  : never;

type ModelProviderOAuthRequiredRefreshOutputName<
  ProviderKey extends ModelProviderOAuthProviderKey,
> = {
  readonly [OutputName in keyof ModelProviderOAuthSecretMetadataMap[ProviderKey]["outputs"]]: ModelProviderOAuthSecretMetadataMap[ProviderKey]["outputs"][OutputName] extends ModelProviderOAuthRefreshableSecretName<ProviderKey>
    ? OutputName
    : never;
}[keyof ModelProviderOAuthSecretMetadataMap[ProviderKey]["outputs"]];

type ModelProviderOAuthRefreshOutputValues<
  ProviderKey extends ModelProviderOAuthProviderKey,
> = Readonly<
  Record<
    Extract<ModelProviderOAuthRequiredRefreshOutputName<ProviderKey>, string>,
    string
  >
> & {
  readonly [OutputName in Exclude<
    keyof ModelProviderOAuthSecretMetadataMap[ProviderKey]["outputs"],
    ModelProviderOAuthRequiredRefreshOutputName<ProviderKey>
  >]?: string;
};

type ModelProviderOAuthProviderMap = {
  readonly [Key in ModelProviderOAuthProviderKey]: ModelProviderRefreshTokenAuthProvider<
    ModelProviderOAuthRefreshInputValues<Key>,
    ModelProviderOAuthRefreshOutputValues<Key>
  >;
};

const MODEL_PROVIDER_OAUTH_PROVIDERS: ModelProviderOAuthProviderMap = {
  "codex-oauth-token": codexOauthProvider,
};

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
  return Boolean(access.resolveAuthClient(args.currentEnv));
}

export async function refreshModelProviderOAuthToken<
  ProviderKey extends ModelProviderOAuthProviderKey,
>(args: {
  readonly providerKey: ProviderKey;
  readonly currentEnv: ProviderEnv;
  readonly inputs: ModelProviderOAuthRefreshInputValues<ProviderKey>;
  readonly signal: AbortSignal;
}): Promise<
  ModelProviderAuthProviderRefreshResult<
    ModelProviderOAuthRefreshOutputValues<ProviderKey>
  >
> {
  const access = MODEL_PROVIDER_OAUTH_PROVIDERS[args.providerKey].access;
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
