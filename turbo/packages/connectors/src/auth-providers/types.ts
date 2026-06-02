import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorAuthMethodIds,
  ConnectorAuthMethodIdsByAccessKind,
  ConnectorAuthMethodIdsByRevokeKind,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthProviderType,
  ConnectorType,
  DeviceAuthGrantConnectorType,
  RefreshTokenAccessConnectorType,
  TokenRevokeConnectorType,
} from "../connectors";
import type { StaticConnectorAuthClient } from "../connector-utils";
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

export type ConnectorAuthProviderAccess<
  T extends ConnectorType,
  Method extends ConnectorAuthMethodIds<T> = ConnectorAuthMethodIds<T>,
> =
  Method extends ConnectorAuthMethodIdsByAccessKind<
    T & RefreshTokenAccessConnectorType,
    "refresh-token"
  >
    ? RefreshTokenAccessProvider<
        T & RefreshTokenAccessConnectorType,
        Method &
          ConnectorAuthMethodIdsByAccessKind<
            T & RefreshTokenAccessConnectorType,
            "refresh-token"
          >
      >
    : NoneAccessProvider;

interface NoneRevokeProvider {
  readonly kind: "none";
}

export interface TokenRevokeProvider<
  T extends TokenRevokeConnectorType,
  Method extends ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke"> =
    ConnectorAuthMethodIdsByRevokeKind<T, "token-revoke">,
> {
  readonly kind: "token-revoke";
  revokeToken(args: ConnectorAuthProviderRevokeArgs<T, Method>): Promise<void>;
}

export type ConnectorAuthProviderRevoke<
  T extends ConnectorAuthProviderType,
  Method extends ConnectorAuthMethodIds<T> = ConnectorAuthMethodIds<T>,
> =
  Method extends ConnectorAuthMethodIdsByRevokeKind<
    T & TokenRevokeConnectorType,
    "token-revoke"
  >
    ? TokenRevokeProvider<
        T & TokenRevokeConnectorType,
        Method &
          ConnectorAuthMethodIdsByRevokeKind<
            T & TokenRevokeConnectorType,
            "token-revoke"
          >
      >
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
  ConnectorAuthProviderAccess<T, Method>,
  ConnectorAuthProviderRevoke<T, Method>
>;

export type DeviceAuthConnectorAuthProvider<
  T extends DeviceAuthGrantConnectorType,
  Method extends ConnectorDeviceAuthGrantAuthMethodId<T> =
    ConnectorDeviceAuthGrantAuthMethodId<T>,
> = AuthProvider<
  DeviceAuthGrantProvider<T, Method>,
  ConnectorAuthProviderAccess<T, Method>,
  ConnectorAuthProviderRevoke<T, Method>
>;

export type ModelProviderGrantProvider = NoneGrantProvider;

export type ModelProviderAuthClient = StaticConnectorAuthClient;

interface ModelProviderAuthProviderRefreshArgs {
  readonly authClient: ModelProviderAuthClient;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
}

interface ModelProviderRefreshTokenAccessProvider {
  readonly kind: "refresh-token";
  getAccessSecretName(): string;
  getRefreshSecretName(): string;
  resolveAuthClient(
    currentEnv: ProviderEnv,
  ): ModelProviderAuthClient | undefined;
  refreshToken(
    args: ModelProviderAuthProviderRefreshArgs,
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
