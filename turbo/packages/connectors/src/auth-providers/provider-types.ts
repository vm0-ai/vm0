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
} from "../oauth-providers/provider-types";

export interface NoneGrantProvider {
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

export type ConnectorGrantProvider<T extends OAuthConnectorType> =
  T extends OAuthAuthCodeConnectorType
    ? NoneGrantProvider | AuthCodeGrantProvider<T>
    : T extends OAuthDeviceAuthConnectorType
      ? NoneGrantProvider | DeviceAuthGrantProvider<T>
      : NoneGrantProvider;

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

export type ConnectorAccessProvider<T extends OAuthConnectorType> =
  | NoneAccessProvider
  | RefreshTokenAccessProvider<T>;

export interface NoneRevokeProvider {
  readonly kind: "none";
}

export interface TokenRevokeProvider<T extends OAuthConnectorType> {
  readonly kind: "token-revoke";
  revokeToken(args: ConnectorOAuthRevokeArgs<T>): Promise<void>;
}

export type ConnectorRevokeProvider<T extends OAuthConnectorType> =
  | NoneRevokeProvider
  | TokenRevokeProvider<T>;

interface BaseConnectorAuthProvider<T extends OAuthConnectorType> {
  readonly access: ConnectorAccessProvider<T>;
  readonly revoke: ConnectorRevokeProvider<T>;
}

export interface AuthCodeConnectorAuthProvider<
  T extends OAuthAuthCodeConnectorType,
> extends BaseConnectorAuthProvider<T> {
  readonly grant: NoneGrantProvider | AuthCodeGrantProvider<T>;
}

export interface DeviceAuthConnectorAuthProvider<
  T extends OAuthDeviceAuthConnectorType,
> extends BaseConnectorAuthProvider<T> {
  readonly grant: NoneGrantProvider | DeviceAuthGrantProvider<T>;
}

export type ConnectorAuthProvider<T extends OAuthConnectorType> =
  BaseConnectorAuthProvider<T> & {
    readonly grant: ConnectorGrantProvider<T>;
  };
