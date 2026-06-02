import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantConfig,
  ConnectorAuthClientConfig,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorDeviceAuthGrantConfig,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthMethodClientConfig,
  ConnectorAuthMethodIdsByAccessKind,
  ConnectorAuthMethodIdsByRevokeKind,
  ConnectorAuthProviderType,
  DeviceAuthGrantConnectorType,
  RefreshTokenAccessConnectorType,
} from "@vm0/connectors/connectors";

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number; // seconds until access token expires
  scopes: string[];
  userInfo: { id: string; username: string | null; email: string | null };
  extraConnectorSecrets?: Readonly<Record<string, string>>;
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
  readonly signal: AbortSignal;
}

interface OAuthRevokeFlowArgs {
  readonly accessToken: string;
}

interface OAuthDeviceAuthStartFlowArgs {
  readonly scopes: readonly string[];
}

interface OAuthDeviceAuthPollFlowArgs {
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

export type OAuthDeviceAuthStartArgs = OAuthDeviceAuthStartFlowArgs &
  OptionalClientCredentialArgs;

export type OAuthDeviceAuthPollArgs = OAuthDeviceAuthPollFlowArgs &
  OptionalClientCredentialArgs;

export interface OAuthRefreshResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn?: number;
}

export interface OAuthDeviceAuthStartResult {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval?: number;
}

export interface OAuthDeviceAuthPendingResult {
  readonly status: "pending";
  readonly interval?: number;
}

export interface OAuthDeviceAuthSlowDownResult {
  readonly status: "slow_down";
}

export interface OAuthDeviceAuthCompleteResult {
  readonly status: "complete";
  readonly token: OAuthTokenResult;
}

export interface OAuthDeviceAuthDeniedResult {
  readonly status: "denied";
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface OAuthDeviceAuthExpiredResult {
  readonly status: "expired";
  readonly error?: string;
  readonly errorDescription?: string;
}

export interface OAuthDeviceAuthErrorResult {
  readonly status: "error";
  readonly error: string;
  readonly errorDescription?: string;
}

export type OAuthDeviceAuthPollResult =
  | OAuthDeviceAuthPendingResult
  | OAuthDeviceAuthSlowDownResult
  | OAuthDeviceAuthCompleteResult
  | OAuthDeviceAuthDeniedResult
  | OAuthDeviceAuthExpiredResult
  | OAuthDeviceAuthErrorResult;

type ConnectorAccessProviderClientFor<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> = ConnectorAuthMethodClientConfig<T, Method> & ConnectorAuthClientConfig;

type ConnectorRevokeProviderClientFor<
  T extends ConnectorAuthProviderType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
> = ConnectorAuthMethodClientConfig<T, Method> & ConnectorAuthClientConfig;

type NoClientCredentialArgs = Record<never, never>;

type StaticClientIdArgs<Client extends ConnectorAuthClientConfig> =
  Client extends { readonly clientRegistration: "static" }
    ? { readonly clientId: string }
    : NoClientCredentialArgs;

type TokenCredentialArgs<Client extends ConnectorAuthClientConfig> =
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

export type ConnectorAuthCodeAuthorizeArgs<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T> =
    ConnectorAuthCodeGrantAuthMethodId<T>,
> = OAuthAuthorizeFlowArgs &
  StaticClientIdArgs<ConnectorAuthMethodClientConfig<T, Method>> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorAuthCodeExchangeArgs<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T> =
    ConnectorAuthCodeGrantAuthMethodId<T>,
> = OAuthExchangeFlowArgs &
  TokenCredentialArgs<ConnectorAuthMethodClientConfig<T, Method>> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorAuthProviderRefreshArgs<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token"> =
    ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> = OAuthRefreshFlowArgs &
  TokenCredentialArgs<ConnectorAccessProviderClientFor<T, Method>> & {
    readonly tokenUrl: string;
  };

export type ConnectorAuthProviderRevokeArgs<
  T extends ConnectorAuthProviderType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke"> =
    ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
> = OAuthRevokeFlowArgs &
  TokenCredentialArgs<ConnectorRevokeProviderClientFor<T, Method>>;

export type ConnectorDeviceAuthorizationStartArgs<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = OAuthDeviceAuthStartFlowArgs &
  StaticClientIdArgs<ConnectorAuthMethodClientConfig<T, Method>> & {
    readonly deviceAuthGrant: ConnectorDeviceAuthGrantConfig;
  };

export type ConnectorDeviceAuthorizationPollArgs<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = OAuthDeviceAuthPollFlowArgs &
  TokenCredentialArgs<ConnectorAuthMethodClientConfig<T, Method>> & {
    readonly deviceAuthGrant: ConnectorDeviceAuthGrantConfig;
  };
