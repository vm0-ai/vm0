import type {
  CONNECTOR_TYPES,
  ConnectorOAuthClientConfig,
  OAuthConnectorType,
  OAuthDeviceAuthConnectorType,
} from "@vm0/connectors/connectors";

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

type ConnectorOAuthClientFor<T extends OAuthConnectorType> = {
  [Method in keyof (typeof CONNECTOR_TYPES)[T]["authMethods"]]: (typeof CONNECTOR_TYPES)[T]["authMethods"][Method] extends {
    readonly grant: {
      readonly kind: "auth-code" | "device-auth";
      readonly client: infer Client;
    };
  }
    ? Client
    : never;
}[keyof (typeof CONNECTOR_TYPES)[T]["authMethods"]] &
  ConnectorOAuthClientConfig;

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

export type ConnectorOAuthDeviceAuthStartArgs<
  T extends OAuthDeviceAuthConnectorType,
> = OAuthDeviceAuthStartFlowArgs &
  StaticClientIdArgs<ConnectorOAuthClientFor<T>>;

export type ConnectorOAuthDeviceAuthPollArgs<
  T extends OAuthDeviceAuthConnectorType,
> = OAuthDeviceAuthPollFlowArgs &
  TokenCredentialArgs<ConnectorOAuthClientFor<T>>;
