import type {
  CONNECTOR_TYPES,
  ConnectorOAuthClientConfig,
  OAuthAuthorizationCodeConnectorType,
  OAuthConnectorType,
  OAuthDeviceAuthorizationConnectorType,
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

interface OAuthDeviceAuthorizationStartFlowArgs {
  readonly scopes: readonly string[];
}

interface OAuthDeviceAuthorizationPollFlowArgs {
  readonly deviceCode: string;
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

export type OAuthDeviceAuthorizationStartArgs =
  OAuthDeviceAuthorizationStartFlowArgs & OptionalClientCredentialArgs;

export type OAuthDeviceAuthorizationPollArgs =
  OAuthDeviceAuthorizationPollFlowArgs & OptionalClientCredentialArgs;

export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
}

export interface OAuthDeviceAuthorizationStartResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval?: number;
}

export interface OAuthDeviceAuthorizationPendingResult {
  readonly status: "pending";
  readonly interval?: number;
}

export interface OAuthDeviceAuthorizationCompleteResult {
  readonly status: "complete";
  readonly token: OAuthTokenResult;
}

export interface OAuthDeviceAuthorizationDeniedResult {
  readonly status: "denied";
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface OAuthDeviceAuthorizationExpiredResult {
  readonly status: "expired";
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface OAuthDeviceAuthorizationErrorResult {
  readonly status: "error";
  readonly error: string;
  readonly errorDescription?: string;
}

export type OAuthDeviceAuthorizationPollResult =
  | OAuthDeviceAuthorizationPendingResult
  | OAuthDeviceAuthorizationCompleteResult
  | OAuthDeviceAuthorizationDeniedResult
  | OAuthDeviceAuthorizationExpiredResult
  | OAuthDeviceAuthorizationErrorResult;

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

export type StartDeviceAuthorizationFn = (
  args: OAuthDeviceAuthorizationStartArgs,
) => Promise<OAuthDeviceAuthorizationStartResult>;

export type PollDeviceAuthorizationFn = (
  args: OAuthDeviceAuthorizationPollArgs,
) => Promise<OAuthDeviceAuthorizationPollResult>;

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

export type ConnectorOAuthDeviceAuthorizationStartArgs<
  T extends OAuthDeviceAuthorizationConnectorType,
> = OAuthDeviceAuthorizationStartFlowArgs &
  StaticClientIdArgs<ConnectorOAuthClientFor<T>>;

export type ConnectorOAuthDeviceAuthorizationPollArgs<
  T extends OAuthDeviceAuthorizationConnectorType,
> = OAuthDeviceAuthorizationPollFlowArgs &
  TokenCredentialArgs<ConnectorOAuthClientFor<T>>;

type BuildConnectorAuthUrlFn<T extends OAuthAuthorizationCodeConnectorType> = (
  args: ConnectorOAuthAuthorizeArgs<T>,
) => string | AuthUrlResult | Promise<string | AuthUrlResult>;

type ExchangeConnectorCodeFn<T extends OAuthAuthorizationCodeConnectorType> = (
  args: ConnectorOAuthExchangeArgs<T>,
) => Promise<OAuthTokenResult>;

type RefreshConnectorTokenFn<T extends OAuthConnectorType> = (
  args: ConnectorOAuthRefreshArgs<T>,
) => Promise<OAuthRefreshResult>;

type RevokeConnectorTokenFn<T extends OAuthConnectorType> = (
  args: ConnectorOAuthRevokeArgs<T>,
) => Promise<void>;

type StartConnectorDeviceAuthorizationFn<
  T extends OAuthDeviceAuthorizationConnectorType,
> = (
  args: ConnectorOAuthDeviceAuthorizationStartArgs<T>,
) => Promise<OAuthDeviceAuthorizationStartResult>;

type PollConnectorDeviceAuthorizationFn<
  T extends OAuthDeviceAuthorizationConnectorType,
> = (
  args: ConnectorOAuthDeviceAuthorizationPollArgs<T>,
) => Promise<OAuthDeviceAuthorizationPollResult>;

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

export type OAuthDeviceAuthorizationProvider = OAuthProvider & {
  startDeviceAuthorization: StartDeviceAuthorizationFn;
  pollDeviceAuthorization: PollDeviceAuthorizationFn;
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

export type ConnectorOAuthAuthorizationCodeProvider<
  T extends OAuthAuthorizationCodeConnectorType,
> = OAuthProviderMetadata & {
  buildAuthUrl: BuildConnectorAuthUrlFn<T>;
  exchangeCode: ExchangeConnectorCodeFn<T>;
};

export type ConnectorOAuthDeviceAuthorizationProvider<
  T extends OAuthDeviceAuthorizationConnectorType,
> = OAuthProviderMetadata & {
  startDeviceAuthorization: StartConnectorDeviceAuthorizationFn<T>;
  pollDeviceAuthorization: PollConnectorDeviceAuthorizationFn<T>;
};

export type ConnectorOAuthRefreshProvider<T extends OAuthConnectorType> = {
  getRefreshSecretName(): string;
  refreshToken: RefreshConnectorTokenFn<T>;
};

export type ConnectorOAuthRevocationProvider<T extends OAuthConnectorType> = {
  revokeToken: RevokeConnectorTokenFn<T>;
};

type ConnectorOAuthFlowProvider<T extends OAuthConnectorType> =
  T extends OAuthAuthorizationCodeConnectorType
    ? ConnectorOAuthAuthorizationCodeProvider<T>
    : T extends OAuthDeviceAuthorizationConnectorType
      ? ConnectorOAuthDeviceAuthorizationProvider<T>
      : never;

export type ConnectorOAuthProviderFor<T extends OAuthConnectorType> =
  ConnectorOAuthFlowProvider<T> &
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
