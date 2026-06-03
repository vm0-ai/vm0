import type {
  AuthCodeGrantConnectorType,
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorAuthMethodIds,
  ConnectorAuthMethodIdsByAccessKind,
  ConnectorAuthMethodIdsByRevokeKind,
  ConnectorDeviceAuthGrantAuthMethodId,
  ConnectorAuthProviderType,
  ConnectorRefreshInputValues,
  ConnectorRefreshOutputValues,
  ConnectorType,
  DeviceAuthGrantConnectorType,
  RefreshTokenAccessConnectorType,
  TokenRevokeConnectorType,
} from "../connectors";
import type {
  ConnectorAuthClientForMethod,
  StaticConnectorAuthClient,
} from "../connector-utils";
import type {
  AuthUrlResult,
  ConnectorAuthCodeAuthorizeArgs,
  ConnectorDeviceAuthorizationPollArgs,
  ConnectorDeviceAuthorizationStartArgs,
  ConnectorAuthCodeExchangeArgs,
  ConnectorAuthProviderRevokeArgs,
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
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
  ): Promise<OAuthTokenResult<T, Method>>;
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
  ): Promise<OAuthDeviceAuthPollResult<T, Method>>;
}

export interface NoneAccessProvider {
  readonly kind: "none";
}

export type ConnectorAuthProviderRefreshArgs<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token"> =
    ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> = {
  readonly authClient: ConnectorAuthClientForMethod<T, Method>;
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

export interface RefreshTokenAccessProvider<
  T extends RefreshTokenAccessConnectorType,
  Method extends ConnectorAuthMethodIdsByAccessKind<T, "refresh-token"> =
    ConnectorAuthMethodIdsByAccessKind<T, "refresh-token">,
> {
  readonly kind: "refresh-token";
  refresh(
    args: ConnectorAuthProviderRefreshArgs<T, Method>,
  ): Promise<ConnectorAuthProviderRefreshResult<T, Method>>;
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

type ModelProviderAuthProviderRefreshInputs = Readonly<Record<string, string>>;

type ModelProviderAuthProviderRefreshOutputs = Readonly<
  Record<string, string | undefined>
>;

interface ModelProviderAuthProviderRefreshArgs<
  Inputs extends ModelProviderAuthProviderRefreshInputs =
    ModelProviderAuthProviderRefreshInputs,
> {
  readonly authClient: ModelProviderAuthClient;
  readonly inputs: Inputs;
  readonly signal: AbortSignal;
}

export interface ModelProviderAuthProviderRefreshResult<
  Outputs extends ModelProviderAuthProviderRefreshOutputs =
    ModelProviderAuthProviderRefreshOutputs,
> {
  readonly outputs: Outputs;
  readonly expiresIn?: number;
}

export interface ModelProviderRefreshTokenAccessProvider<
  Inputs extends ModelProviderAuthProviderRefreshInputs =
    ModelProviderAuthProviderRefreshInputs,
  Outputs extends ModelProviderAuthProviderRefreshOutputs =
    ModelProviderAuthProviderRefreshOutputs,
> {
  readonly kind: "refresh-token";
  resolveAuthClient(
    currentEnv: ProviderEnv,
  ): ModelProviderAuthClient | undefined;
  refresh(
    args: ModelProviderAuthProviderRefreshArgs<Inputs>,
  ): Promise<ModelProviderAuthProviderRefreshResult<Outputs>>;
}

export type ModelProviderAccessProvider<
  Inputs extends ModelProviderAuthProviderRefreshInputs =
    ModelProviderAuthProviderRefreshInputs,
  Outputs extends ModelProviderAuthProviderRefreshOutputs =
    ModelProviderAuthProviderRefreshOutputs,
> =
  | NoneAccessProvider
  | ModelProviderRefreshTokenAccessProvider<Inputs, Outputs>;

export type ModelProviderRevokeProvider = NoneRevokeProvider;

export type ModelProviderAuthProvider<
  Inputs extends ModelProviderAuthProviderRefreshInputs =
    ModelProviderAuthProviderRefreshInputs,
  Outputs extends ModelProviderAuthProviderRefreshOutputs =
    ModelProviderAuthProviderRefreshOutputs,
> = AuthProvider<
  ModelProviderGrantProvider,
  ModelProviderAccessProvider<Inputs, Outputs>,
  ModelProviderRevokeProvider
>;

export type ModelProviderRefreshTokenAuthProvider<
  Inputs extends ModelProviderAuthProviderRefreshInputs =
    ModelProviderAuthProviderRefreshInputs,
  Outputs extends ModelProviderAuthProviderRefreshOutputs =
    ModelProviderAuthProviderRefreshOutputs,
> = AuthProvider<
  ModelProviderGrantProvider,
  ModelProviderRefreshTokenAccessProvider<Inputs, Outputs>,
  ModelProviderRevokeProvider
>;
