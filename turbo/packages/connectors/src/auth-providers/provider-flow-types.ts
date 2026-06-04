import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantConfig,
  ConnectorAuthMethodIds,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthMethodIdsByRevokeKind,
  ConnectorRevokeInputValues,
  ConnectorType,
  DeviceAuthGrantConnectorType,
  TokenRevokeConnectorType,
} from "@vm0/connectors/connectors";
import type {
  ConnectorAuthClientForMethod,
  ConnectorAuthClientIdentityForMethod,
} from "@vm0/connectors/connector-utils";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
} from "./grant-result";

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
  readonly token: ConnectorAuthProviderGrantResult;
}

export interface OAuthDeviceAuthCompleteResult<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T>,
> {
  readonly status: "complete";
  readonly token: ConnectorAuthProviderGrantResultForMethod<T, Method>;
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
