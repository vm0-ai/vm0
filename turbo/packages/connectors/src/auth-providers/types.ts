import type {
  OAuthAuthCodeConnectorType,
  OAuthConnectorType,
  OAuthDeviceAuthConnectorType,
} from "../connectors";
import type {
  AuthUrlResult,
  ConnectorOAuthAuthorizeArgs,
  ConnectorOAuthDeviceAuthPollArgs,
  ConnectorOAuthDeviceAuthStartArgs,
  ConnectorOAuthExchangeArgs,
  ConnectorOAuthRefreshArgs,
  ConnectorOAuthRevokeArgs,
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
  OAuthRefreshResult,
  OAuthTokenResult,
} from "./oauth/types";
import type { ProviderEnv } from "./provider-env";

interface NoneGrantProvider {
  readonly kind: "none";
}

export interface AuthCodeGrantProvider<T extends OAuthAuthCodeConnectorType> {
  readonly kind: "auth-code";
  buildAuthUrl(
    args: ConnectorOAuthAuthorizeArgs<T>,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(args: ConnectorOAuthExchangeArgs<T>): Promise<OAuthTokenResult>;
}

export interface DeviceAuthGrantProvider<
  T extends OAuthDeviceAuthConnectorType,
> {
  readonly kind: "device-auth";
  startDeviceAuth(
    args: ConnectorOAuthDeviceAuthStartArgs<T>,
  ): Promise<OAuthDeviceAuthStartResult>;
  pollDeviceAuth(
    args: ConnectorOAuthDeviceAuthPollArgs<T>,
  ): Promise<OAuthDeviceAuthPollResult>;
}

export interface NoneAccessProvider {
  readonly kind: "none";
  getAccessSecretName(): string;
}

export interface RefreshTokenAccessProvider<T extends OAuthConnectorType> {
  readonly kind: "refresh-token";
  getAccessSecretName(): string;
  getRefreshSecretName(): string;
  refreshToken(args: ConnectorOAuthRefreshArgs<T>): Promise<OAuthRefreshResult>;
}

export type OAuthConnectorAccessProvider<T extends OAuthConnectorType> =
  | NoneAccessProvider
  | RefreshTokenAccessProvider<T>;

interface NoneRevokeProvider {
  readonly kind: "none";
}

interface TokenRevokeProvider<T extends OAuthConnectorType> {
  readonly kind: "token-revoke";
  revokeToken(args: ConnectorOAuthRevokeArgs<T>): Promise<void>;
}

export type OAuthConnectorRevokeProvider<T extends OAuthConnectorType> =
  | NoneRevokeProvider
  | TokenRevokeProvider<T>;

export interface AuthProvider<TGrant, TAccess, TRevoke> {
  readonly grant: TGrant;
  readonly access: TAccess;
  readonly revoke: TRevoke;
}

export type AuthCodeConnectorAuthProvider<
  T extends OAuthAuthCodeConnectorType,
> = AuthProvider<
  AuthCodeGrantProvider<T>,
  OAuthConnectorAccessProvider<T>,
  OAuthConnectorRevokeProvider<T>
>;

export type DeviceAuthConnectorAuthProvider<
  T extends OAuthDeviceAuthConnectorType,
> = AuthProvider<
  DeviceAuthGrantProvider<T>,
  OAuthConnectorAccessProvider<T>,
  OAuthConnectorRevokeProvider<T>
>;

export type ModelProviderGrantProvider = NoneGrantProvider;

interface ModelProviderOAuthRefreshArgs {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly refreshToken: string;
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
