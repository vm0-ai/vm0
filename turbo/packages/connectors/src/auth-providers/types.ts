import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorAuthMethodIdsByAccessKind,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthProviderType,
  ConnectorType,
  DeviceAuthGrantConnectorType,
  RefreshTokenAccessConnectorType,
  TokenRevokeConnectorType,
} from "../connectors";
import type {
  AuthUrlResult,
  ConnectorAuthCodeAuthorizeArgs,
  ConnectorDeviceAuthorizationPollArgs,
  ConnectorDeviceAuthorizationStartArgs,
  ConnectorAuthCodeExchangeArgs,
  ConnectorAuthProviderRefreshArgs,
  ConnectorAuthProviderRevokeArgs,
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
  OAuthRefreshResult,
  OAuthTokenResult,
} from "./oauth/types";
import type { ProviderEnv } from "./provider-env";

interface NoneGrantProvider {
  readonly kind: "none";
}

export interface AuthCodeGrantProvider<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T> =
    ConnectorAuthCodeGrantAuthMethodId<T>,
> {
  readonly kind: "auth-code";
  buildAuthUrl(
    args: ConnectorAuthCodeAuthorizeArgs<T, Method>,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(
    args: ConnectorAuthCodeExchangeArgs<T, Method>,
  ): Promise<OAuthTokenResult>;
}

export interface DeviceAuthGrantProvider<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> {
  readonly kind: "device-auth";
  startDeviceAuth(
    args: ConnectorDeviceAuthorizationStartArgs<T, Method>,
  ): Promise<OAuthDeviceAuthStartResult>;
  pollDeviceAuth(
    args: ConnectorDeviceAuthorizationPollArgs<T, Method>,
  ): Promise<OAuthDeviceAuthPollResult>;
}

export interface NoneAccessProvider {
  readonly kind: "none";
  getAccessSecretName(): string;
}

export interface RefreshTokenAccessProvider<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token"> =
    ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> {
  readonly kind: "refresh-token";
  getAccessSecretName(): string;
  getRefreshSecretName(): string;
  refreshToken(
    args: ConnectorAuthProviderRefreshArgs<T, Method>,
  ): Promise<OAuthRefreshResult>;
}

export type ConnectorAuthProviderAccess<T extends ConnectorType> =
  T extends RefreshTokenAccessConnectorType
    ? RefreshTokenAccessProvider<T>
    : NoneAccessProvider;

interface NoneRevokeProvider {
  readonly kind: "none";
}

interface TokenRevokeProvider<T extends ConnectorAuthProviderType> {
  readonly kind: "token-revoke";
  revokeToken(args: ConnectorAuthProviderRevokeArgs<T>): Promise<void>;
}

export type ConnectorAuthProviderRevoke<T extends ConnectorAuthProviderType> =
  T extends TokenRevokeConnectorType
    ? TokenRevokeProvider<T>
    : NoneRevokeProvider;

export interface AuthProvider<TGrant, TAccess, TRevoke> {
  readonly grant: TGrant;
  readonly access: TAccess;
  readonly revoke: TRevoke;
}

export type AuthCodeConnectorAuthProvider<
  T extends AuthCodeGrantConnectorType,
  Method extends ConnectorAuthCodeGrantAuthMethodId<T> =
    ConnectorAuthCodeGrantAuthMethodId<T>,
> = AuthProvider<
  AuthCodeGrantProvider<T, Method>,
  ConnectorAuthProviderAccess<T>,
  ConnectorAuthProviderRevoke<T>
>;

export type DeviceAuthConnectorAuthProvider<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = AuthProvider<
  DeviceAuthGrantProvider<T, Method>,
  ConnectorAuthProviderAccess<T>,
  ConnectorAuthProviderRevoke<T>
>;

export type ModelProviderGrantProvider = NoneGrantProvider;

interface ModelProviderOAuthRefreshArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
}

interface ModelProviderRefreshTokenAccessProvider {
  readonly kind: "refresh-token";
  getAccessSecretName(): string;
  getRefreshSecretName(): string;
  getClientId(currentEnv: ProviderEnv): string | undefined;
  getClientSecret(currentEnv: ProviderEnv): string | undefined;
  refreshToken(
    args: ModelProviderOAuthRefreshArgs,
  ): Promise<OAuthRefreshResult>;
}

export type ModelProviderAccessProvider =
  | NoneAccessProvider
  | ModelProviderRefreshTokenAccessProvider;

export type ModelProviderRevokeProvider = NoneRevokeProvider;

export type ModelProviderAuthProvider = AuthProvider<
  ModelProviderGrantProvider,
  ModelProviderAccessProvider,
  ModelProviderRevokeProvider
>;
