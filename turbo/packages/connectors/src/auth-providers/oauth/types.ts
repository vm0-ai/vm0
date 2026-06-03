import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantConfig,
  ConnectorAuthMethodIds,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthMethodIdsByAccessKind,
  ConnectorAuthMethodIdsByRevokeKind,
  ConnectorGrantOutputValues,
  ConnectorRefreshInputValues,
  ConnectorRefreshOutputValues,
  ConnectorRevokeInputValues,
  ConnectorType,
  DeviceAuthGrantConnectorType,
  RefreshTokenAccessConnectorType,
  TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import type {
  ConnectorAuthClientForMethod,
  ConnectorAuthClientIdentityForMethod,
} from "@vm0/connectors/connector-utils";

export interface OAuthTokenUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

export interface OAuthTokenResultFields {
  expiresIn?: number; // seconds until access token expires
  scopes: string[];
  userInfo: OAuthTokenUserInfo;
  extraConnectorSecrets?: Readonly<Record<string, string>>;
}

export type OAuthTokenResultBase = OAuthTokenResultFields & {
  readonly outputs: Readonly<Record<string, string | null | undefined>>;
};

export type OAuthTokenResult<
  T extends AuthCodeGrantConnectorType | DeviceAuthGrantConnectorType,
  Method extends ConnectorAuthMethodIds<T>,
> = OAuthTokenResultFields & {
  readonly outputs: ConnectorGrantOutputValues<T, Method>;
};

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

export function oauthRefreshResultToProviderResult(
  result: OAuthRefreshResult,
): {
  readonly outputs: {
    readonly accessToken: string;
    readonly refreshToken?: string;
  };
  readonly expiresIn?: number;
} {
  return {
    outputs: {
      accessToken: result.accessToken,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
    },
    ...(result.expiresIn === undefined ? {} : { expiresIn: result.expiresIn }),
  };
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

export interface OAuthDeviceAuthCompleteResultBase {
  readonly status: "complete";
  readonly token: OAuthTokenResultBase;
}

export interface OAuthDeviceAuthCompleteResult<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
> {
  readonly status: "complete";
  readonly token: OAuthTokenResult<T, Method>;
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

export type OAuthDeviceAuthPollResultBase =
  | OAuthDeviceAuthPendingResult
  | OAuthDeviceAuthSlowDownResult
  | OAuthDeviceAuthCompleteResultBase
  | OAuthDeviceAuthDeniedResult
  | OAuthDeviceAuthExpiredResult
  | OAuthDeviceAuthErrorResult;

export type OAuthDeviceAuthIncompleteResult = Exclude<
  OAuthDeviceAuthPollResultBase,
  OAuthDeviceAuthCompleteResultBase
>;

export type OAuthDeviceAuthPollResult<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
> =
  | OAuthDeviceAuthPendingResult
  | OAuthDeviceAuthSlowDownResult
  | OAuthDeviceAuthCompleteResult<T, Method>
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
> = ConnectorAuthMethodClientArgs<T, Method> & {
  readonly inputs: ConnectorRefreshInputValues<T, Method>;
  readonly signal: AbortSignal;
};

export interface ConnectorAuthProviderRefreshResultBase {
  readonly outputs: Readonly<Record<string, string | undefined>>;
  readonly expiresIn?: number;
}

export interface ConnectorAuthProviderRefreshResult<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token"> =
    ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> extends ConnectorAuthProviderRefreshResultBase {
  readonly outputs: ConnectorRefreshOutputValues<T, Method>;
}

export type ConnectorAuthProviderRevokeArgs<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke"> =
    ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
> = ConnectorAuthMethodClientArgs<T, Method> & {
  readonly inputs: ConnectorRevokeInputValues<T, Method>;
};

export type ConnectorDeviceAuthorizationStartArgs<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = OAuthDeviceAuthStartFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<T, Method>;

export type ConnectorDeviceAuthorizationPollArgs<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = OAuthDeviceAuthPollFlowArgs & ConnectorAuthMethodClientArgs<T, Method>;
