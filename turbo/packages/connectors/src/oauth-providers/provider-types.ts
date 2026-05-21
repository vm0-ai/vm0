import type {
  CONNECTOR_TYPES,
  ConnectorOAuthClientConfig,
  OAuthConnectorType,
} from "@vm0/connectors/connectors";

export interface ProviderEnv {
  readonly [name: string]: string | undefined;
}

export function providerEnvFromObject(values: object): ProviderEnv {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string" || !Object.hasOwn(values, property)) {
          return undefined;
        }
        const value = (values as Record<string, unknown>)[property];
        return typeof value === "string" ? value : undefined;
      },
    },
  ) as ProviderEnv;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number; // seconds until access token expires
  scopes: string[];
  userInfo: { id: string; username: string | null; email: string | null };
}

/**
 * Result from buildAuthUrl when PKCE is required.
 * Providers that need PKCE return { url, codeVerifier } instead of a plain string.
 */
export interface AuthUrlResult {
  url: string;
  codeVerifier?: string;
  oauthContext?: string;
}

interface OAuthAuthorizeFlowArgs {
  readonly redirectUri: string;
  readonly state: string;
}

interface OAuthExchangeFlowArgs {
  readonly code: string;
  readonly redirectUri: string;
  readonly state?: string;
  readonly codeVerifier?: string;
  readonly oauthContext?: string;
}

interface OAuthRefreshFlowArgs {
  readonly refreshToken: string;
}

interface OAuthRevokeFlowArgs {
  readonly accessToken: string;
}

type OptionalClientCredentialArgs = {
  readonly clientId?: string;
  readonly clientSecret?: string;
};

export type OAuthAuthorizeArgs = OAuthAuthorizeFlowArgs &
  OptionalClientCredentialArgs;

export type OAuthExchangeArgs = OAuthExchangeFlowArgs &
  OptionalClientCredentialArgs;

export type OAuthRefreshArgs = OAuthRefreshFlowArgs &
  OptionalClientCredentialArgs;

export type OAuthRevokeArgs = OAuthRevokeFlowArgs &
  OptionalClientCredentialArgs;

export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
}

export type BuildAuthUrlFn = (
  args: OAuthAuthorizeArgs,
) => string | AuthUrlResult | Promise<string | AuthUrlResult>;

export type ExchangeCodeFn = (
  args: OAuthExchangeArgs,
) => Promise<OAuthTokenResult>;

export type RefreshTokenFn = (
  args: OAuthRefreshArgs,
) => Promise<OAuthRefreshResult>;

export type RevokeTokenFn = (args: OAuthRevokeArgs) => Promise<void>;

type ConnectorOAuthClientFor<T extends OAuthConnectorType> =
  (typeof CONNECTOR_TYPES)[T]["oauth"]["client"];

type NoClientCredentialArgs = Record<never, never>;

type StaticClientIdArgs<Client extends ConnectorOAuthClientConfig> =
  Client extends { readonly clientRegistration: "static" }
    ? { readonly clientId: string }
    : NoClientCredentialArgs;

type TokenCredentialArgs<Client extends ConnectorOAuthClientConfig> =
  Client extends {
    readonly clientRegistration: "static";
    readonly clientType: "confidential";
  }
    ? { readonly clientId: string; readonly clientSecret: string }
    : Client extends {
          readonly clientRegistration: "static";
          readonly clientType: "public";
        }
      ? { readonly clientId: string }
      : NoClientCredentialArgs;

export type ConnectorOAuthAuthorizeArgs<T extends OAuthConnectorType> =
  OAuthAuthorizeFlowArgs & StaticClientIdArgs<ConnectorOAuthClientFor<T>>;

export type ConnectorOAuthExchangeArgs<T extends OAuthConnectorType> =
  OAuthExchangeFlowArgs & TokenCredentialArgs<ConnectorOAuthClientFor<T>>;

export type ConnectorOAuthRefreshArgs<T extends OAuthConnectorType> =
  OAuthRefreshFlowArgs & TokenCredentialArgs<ConnectorOAuthClientFor<T>>;

export type ConnectorOAuthRevokeArgs<T extends OAuthConnectorType> =
  OAuthRevokeFlowArgs & TokenCredentialArgs<ConnectorOAuthClientFor<T>>;

type BuildConnectorAuthUrlFn<T extends OAuthConnectorType> = (
  args: ConnectorOAuthAuthorizeArgs<T>,
) => string | AuthUrlResult | Promise<string | AuthUrlResult>;

type ExchangeConnectorCodeFn<T extends OAuthConnectorType> = (
  args: ConnectorOAuthExchangeArgs<T>,
) => Promise<OAuthTokenResult>;

type RefreshConnectorTokenFn<T extends OAuthConnectorType> = (
  args: ConnectorOAuthRefreshArgs<T>,
) => Promise<OAuthRefreshResult>;

type RevokeConnectorTokenFn<T extends OAuthConnectorType> = (
  args: ConnectorOAuthRevokeArgs<T>,
) => Promise<void>;

export interface OAuthProviderMetadata {
  getSecretName(): string;
}

export interface OAuthProvider extends OAuthProviderMetadata {
  getClientId(currentEnv: ProviderEnv): string | undefined;
  getClientSecret(currentEnv: ProviderEnv): string | undefined;
}

export type OAuthAuthorizationCodeProvider = OAuthProvider & {
  buildAuthUrl: BuildAuthUrlFn;
  exchangeCode: ExchangeCodeFn;
};

export type OAuthRefreshProvider = OAuthProvider & {
  getRefreshSecretName(): string;
  refreshToken: RefreshTokenFn;
};

export type OAuthRevocationProvider = OAuthProvider & {
  revokeToken: RevokeTokenFn;
};

type OAuthNoRefreshProvider = {
  getRefreshSecretName?: never;
  refreshToken?: never;
};

type OAuthNoRevocationProvider = {
  revokeToken?: never;
};

type ConnectorOAuthAuthorizationCodeProvider<T extends OAuthConnectorType> =
  OAuthProviderMetadata & {
    buildAuthUrl: BuildConnectorAuthUrlFn<T>;
    exchangeCode: ExchangeConnectorCodeFn<T>;
  };

export type ConnectorOAuthRefreshProvider<T extends OAuthConnectorType> = {
  getRefreshSecretName(): string;
  refreshToken: RefreshConnectorTokenFn<T>;
};

export type ConnectorOAuthRevocationProvider<T extends OAuthConnectorType> = {
  revokeToken: RevokeConnectorTokenFn<T>;
};

export type ConnectorOAuthProviderFor<T extends OAuthConnectorType> =
  ConnectorOAuthAuthorizationCodeProvider<T> &
    (ConnectorOAuthRefreshProvider<T> | OAuthNoRefreshProvider) &
    (ConnectorOAuthRevocationProvider<T> | OAuthNoRevocationProvider);

export type AnyConnectorOAuthProvider = {
  [Type in OAuthConnectorType]: ConnectorOAuthProviderFor<Type>;
}[OAuthConnectorType];

export type OAuthConnectorProvider = AnyConnectorOAuthProvider;

export function defineConnectorOAuthProvider<T extends OAuthConnectorType>(
  _type: T,
  provider: ConnectorOAuthProviderFor<T>,
): ConnectorOAuthProviderFor<T> {
  return provider;
}

export function isOAuthRefreshProvider(
  provider: OAuthProviderMetadata,
): provider is OAuthProviderMetadata & {
  getRefreshSecretName(): string;
  refreshToken: RefreshTokenFn;
} {
  return (
    "getRefreshSecretName" in provider &&
    typeof provider.getRefreshSecretName === "function" &&
    "refreshToken" in provider &&
    typeof provider.refreshToken === "function"
  );
}
