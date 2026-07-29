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
  ConnectorAuthProviderConnectorSlug,
  ConnectorAuthProviderConnectorSlugByGrantKind,
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
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
> {
  readonly status: "complete";
  readonly token: ConnectorAuthProviderGrantResultForMethod<
    ConnectorSlug,
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
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
> =
  | OAuthDeviceAuthPendingResult
  | OAuthDeviceAuthSlowDownResult
  | OAuthDeviceAuthCompleteResult<ConnectorSlug, AuthMethodId>
  | OAuthDeviceAuthDeniedResult
  | OAuthDeviceAuthExpiredResult
  | OAuthDeviceAuthErrorResult;

type ConnectorAuthMethodClientArgs<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = {
  readonly authClient: ConnectorAuthProviderClientFor<
    ConnectorSlug,
    AuthMethodId
  >;
};

type ConnectorAuthMethodClientIdentityArgs<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = {
  readonly authClient: ConnectorAuthProviderClientIdentityFor<
    ConnectorSlug,
    AuthMethodId
  >;
};

export type ConnectorAuthCodeAuthorizeArgs<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorSlug, "auth-code">,
> = OAuthAuthorizeFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<ConnectorSlug, AuthMethodId> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorAuthCodeExchangeArgs<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorSlug, "auth-code">,
> = OAuthExchangeFlowArgs &
  ConnectorAuthMethodClientArgs<ConnectorSlug, AuthMethodId> & {
    readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  };

export type ConnectorOpenIdAuthorizeArgs = OpenIdAuthorizeFlowArgs & {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
};

export type ConnectorOpenIdVerifyArgs = OpenIdVerifyFlowArgs & {
  readonly openIdAuthGrant: ConnectorOpenIdAuthGrantConfig;
};

export type ConnectorExternalCodeAuthorizationStartArgs<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  >,
> = ConnectorAuthMethodClientIdentityArgs<ConnectorSlug, AuthMethodId> & {
  readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
};

export type ConnectorExternalCodeAuthorizationCompleteArgs<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  >,
> = ExternalCodeCompleteFlowArgs &
  ConnectorAuthMethodClientArgs<ConnectorSlug, AuthMethodId> & {
    readonly externalCodeGrant: ConnectorExternalCodeGrantConfig;
  };

export type ConnectorAuthProviderRevokeArgs<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthMethodClientArgs<ConnectorSlug, AuthMethodId> & {
  readonly inputs: ConnectorAuthProviderRevokeInputValuesFor<
    ConnectorSlug,
    AuthMethodId
  >;
  readonly signal: AbortSignal;
};

export type ConnectorDeviceAuthorizationStartArgs<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
> = OAuthDeviceAuthStartFlowArgs &
  ConnectorAuthMethodClientIdentityArgs<ConnectorSlug, AuthMethodId>;

export type ConnectorDeviceAuthorizationPollArgs<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
> = OAuthDeviceAuthPollFlowArgs &
  ConnectorAuthMethodClientArgs<ConnectorSlug, AuthMethodId>;
