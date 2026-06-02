import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantConfig,
  ConnectorAuthMethodIds,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorDeviceAuthGrantConfig,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthMethodIdsByAccessKind,
  ConnectorAuthMethodIdsByRevokeKind,
  ConnectorType,
  DeviceAuthGrantConnectorType,
  RefreshTokenAccessConnectorType,
  TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import type {
  ConnectorAuthClientForMethod,
  ConnectorAuthClientIdentityForMethod,
} from "@vm0/connectors/connector-utils";

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

type ConnectorAuthMethodClientArgs<
  T extends ConnectorType,
  Method extends ConnectorAuthMethodIds<T>,
> = {
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
};

type ConnectorAuthMethodClientIdentityArgs<
  T extends ConnectorType,
  Method extends ConnectorAuthMethodIds<T>,
> = {
  readonly authClient: ConnectorAuthClientIdentityForMethod<T, Method>;
};

export type ConnectorAuthCodeAuthorizeArgs<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T> =
    ConnectorAuthCodeGrantAuthMethodId<T>,
> = OAuthAuthorizeFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<T, Method> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorAuthCodeExchangeArgs<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T> =
    ConnectorAuthCodeGrantAuthMethodId<T>,
> = OAuthExchangeFlowArgs &
  ConnectorAuthMethodClientArgs<T, Method> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorAuthProviderRefreshArgs<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token"> =
    ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> = OAuthRefreshFlowArgs &
  ConnectorAuthMethodClientArgs<T, Method> & {
    readonly tokenUrl: string;
  };

export type ConnectorAuthProviderRevokeArgs<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke"> =
    ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
> = OAuthRevokeFlowArgs & ConnectorAuthMethodClientArgs<T, Method>;

export type ConnectorDeviceAuthorizationStartArgs<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = OAuthDeviceAuthStartFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<T, Method> & {
    readonly deviceAuthGrant: ConnectorDeviceAuthGrantConfig;
  };

export type ConnectorDeviceAuthorizationPollArgs<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = OAuthDeviceAuthPollFlowArgs &
  ConnectorAuthMethodClientArgs<T, Method> & {
    readonly deviceAuthGrant: ConnectorDeviceAuthGrantConfig;
  };
