import type {
  ConnectorAuthCodeGrantConfig,
  ConnectorExternalCodeGrantConfig,
  ConnectorOpenIdAuthGrantConfig,
  ConnectorDeviceAuthStartOptions,
} from "@vm0/connectors/connector-config";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantResultForMethod,
} from "./grant-result";
import type {
  ConnectorAuthProviderAuthMethodId,
  ConnectorAuthProviderAuthMethodIdByGrantKind,
  ConnectorAuthProviderClientFor,
  ConnectorAuthProviderClientIdentityFor,
  ConnectorAuthProviderConnectorRef,
  ConnectorAuthProviderConnectorRefByGrantKind,
  ConnectorAuthProviderRevokeInputValuesFor,
} from "./provider-capabilities";

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

interface OpenIdAuthorizeFlowArgs {
  readonly returnTo: string;
  readonly realm: string;
  readonly state: string;
}

interface OpenIdVerifyFlowArgs {
  readonly callbackParams: Readonly<Record<string, string>>;
  readonly expectedReturnTo: string;
  readonly expectedRealm: string;
  readonly signal: AbortSignal;
}

interface OAuthDeviceAuthStartFlowArgs {
  readonly scopes: readonly string[];
  readonly options: ConnectorDeviceAuthStartOptions;
}

interface OAuthDeviceAuthPollFlowArgs {
  readonly deviceCode: string;
  readonly pollState?: string;
}

interface ExternalCodeCompleteFlowArgs {
  readonly code: string;
  readonly providerState: string;
  readonly signal: AbortSignal;
}

export interface ExternalCodeAuthorizationStartResult {
  readonly authorizationUrl: string;
  readonly providerState: string;
  readonly expiresIn: number;
}

export interface OAuthDeviceAuthStartResult {
  readonly deviceCode: string;
  readonly pollState?: string;
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
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "device-auth"
  >,
> {
  readonly status: "complete";
  readonly token: ConnectorAuthProviderGrantResultForMethod<
    ConnectorRef,
    AuthMethodId
  >;
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
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "device-auth"
  >,
> =
  | OAuthDeviceAuthPendingResult
  | OAuthDeviceAuthSlowDownResult
  | OAuthDeviceAuthCompleteResult<ConnectorRef, AuthMethodId>
  | OAuthDeviceAuthDeniedResult
  | OAuthDeviceAuthExpiredResult
  | OAuthDeviceAuthErrorResult;

type ConnectorAuthMethodClientArgs<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = {
  readonly authClient: ConnectorAuthProviderClientFor<
    ConnectorRef,
    AuthMethodId
  >;
};

type ConnectorAuthMethodClientIdentityArgs<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = {
  readonly authClient: ConnectorAuthProviderClientIdentityFor<
    ConnectorRef,
    AuthMethodId
  >;
};

export type ConnectorAuthCodeAuthorizeArgs<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "auth-code">,
> = OAuthAuthorizeFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<ConnectorRef, AuthMethodId> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorAuthCodeExchangeArgs<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "auth-code">,
> = OAuthExchangeFlowArgs &
  ConnectorAuthMethodClientArgs<ConnectorRef, AuthMethodId> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorOpenIdAuthorizeArgs = OpenIdAuthorizeFlowArgs & {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
};

export type ConnectorOpenIdVerifyArgs = OpenIdVerifyFlowArgs & {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
};

export type ConnectorExternalCodeAuthorizationStartArgs<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  >,
> = ConnectorAuthMethodClientIdentityArgs<ConnectorRef, AuthMethodId> & {
  readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
};

export type ConnectorExternalCodeAuthorizationCompleteArgs<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  >,
> = ExternalCodeCompleteFlowArgs &
  ConnectorAuthMethodClientArgs<ConnectorRef, AuthMethodId> & {
    readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
  };

export type ConnectorAuthProviderRevokeArgs<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = ConnectorAuthMethodClientArgs<ConnectorRef, AuthMethodId> & {
  readonly inputs: ConnectorAuthProviderRevokeInputValuesFor<
    ConnectorRef,
    AuthMethodId
  >;
  readonly signal: AbortSignal;
};

export type ConnectorDeviceAuthorizationStartArgs<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "device-auth">,
> = OAuthDeviceAuthStartFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<ConnectorRef, AuthMethodId>;

export type ConnectorDeviceAuthorizationPollArgs<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "device-auth">,
> = OAuthDeviceAuthPollFlowArgs &
  ConnectorAuthMethodClientArgs<ConnectorRef, AuthMethodId>;
