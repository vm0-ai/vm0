import type { StaticConnectorAuthClient } from "../connector-auth-method";
import type {
  AuthUrlResult,
  ConnectorAuthCodeAuthorizeArgs,
  ConnectorAuthCodeExchangeArgs,
  ConnectorAuthProviderRevokeArgs,
  ConnectorDeviceAuthorizationPollArgs,
  ConnectorDeviceAuthorizationStartArgs,
  ConnectorExternalCodeAuthorizationCompleteArgs,
  ConnectorExternalCodeAuthorizationStartArgs,
  ConnectorOpenIdAuthorizeArgs,
  ConnectorOpenIdVerifyArgs,
  ExternalCodeAuthorizationStartResult,
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
} from "./provider-flow-types";
import type { ConnectorAuthProviderGrantResultForMethod } from "./grant-result";
import type {
  ConnectorAuthProviderAuthMethodId,
  ConnectorAuthProviderAuthMethodIdByAccessKind,
  ConnectorAuthProviderAuthMethodIdByGrantKind,
  ConnectorAuthProviderAuthMethodIdByRevokeKind,
  ConnectorAuthProviderClientFor,
  ConnectorAuthProviderConnectorRef,
  ConnectorAuthProviderConnectorRefByGrantKind,
  ConnectorAuthProviderRefreshInputValuesFor,
  ConnectorAuthProviderRefreshOutputValuesFor,
} from "./provider-capabilities";
import type { ProviderEnv } from "./provider-env";

interface NoneGrantProvider {
  readonly kind: "none";
}

export interface AuthCodeGrantProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "auth-code">,
> {
  readonly kind: "auth-code";
  buildAuthUrl(
    args: ConnectorAuthCodeAuthorizeArgs<ConnectorRef, AuthMethodId>,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(
    args: ConnectorAuthCodeExchangeArgs<ConnectorRef, AuthMethodId>,
  ): Promise<
    ConnectorAuthProviderGrantResultForMethod<ConnectorRef, AuthMethodId>
  >;
}

export interface OpenIdAuthGrantProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"openid-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "openid-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "openid-auth">,
> {
  readonly kind: "openid-auth";
  buildAuthUrl(
    args: ConnectorOpenIdAuthorizeArgs,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  verifyCallback(
    args: ConnectorOpenIdVerifyArgs,
  ): Promise<
    ConnectorAuthProviderGrantResultForMethod<ConnectorRef, AuthMethodId>
  >;
}

export interface DeviceAuthGrantProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "device-auth">,
> {
  readonly kind: "device-auth";
  startDeviceAuth(
    args: ConnectorDeviceAuthorizationStartArgs<ConnectorRef, AuthMethodId>,
  ): Promise<OAuthDeviceAuthStartResult>;
  pollDeviceAuth(
    args: ConnectorDeviceAuthorizationPollArgs<ConnectorRef, AuthMethodId>,
  ): Promise<OAuthDeviceAuthPollResult<ConnectorRef, AuthMethodId>>;
}

export interface ExternalCodeGrantProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  >,
> {
  readonly kind: "external-code";
  startExternalCodeAuthorization(
    args: ConnectorExternalCodeAuthorizationStartArgs<
      ConnectorRef,
      AuthMethodId
    >,
  ): Promise<ExternalCodeAuthorizationStartResult>;
  completeExternalCodeAuthorization(
    args: ConnectorExternalCodeAuthorizationCompleteArgs<
      ConnectorRef,
      AuthMethodId
    >,
  ): Promise<
    ConnectorAuthProviderGrantResultForMethod<ConnectorRef, AuthMethodId>
  >;
}

export interface NoneAccessProvider {
  readonly kind: "none";
}

export type ConnectorAuthProviderRefreshArgs<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef> =
    ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> =
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>
    ? {
        readonly inputs: ConnectorAuthProviderRefreshInputValuesFor<
          ConnectorRef,
          AuthMethodId
        >;
        readonly signal: AbortSignal;
      } & ConnectorRefreshAuthClientArgs<ConnectorRef, AuthMethodId>
    : never;

type ConnectorRefreshAuthClientArgs<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> = [ConnectorAuthProviderClientFor<ConnectorRef, AuthMethodId>] extends [never]
  ? unknown
  : {
      readonly authClient: ConnectorAuthProviderClientFor<
        ConnectorRef,
        AuthMethodId
      >;
    };

export interface ConnectorAuthProviderRefreshResultBase {
  readonly outputs: Readonly<Record<string, string | undefined>>;
  readonly expiresIn?: number;
}

export interface ConnectorAuthProviderRefreshResult<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> extends ConnectorAuthProviderRefreshResultBase {
  readonly outputs: ConnectorAuthProviderRefreshOutputValuesFor<
    ConnectorRef,
    AuthMethodId
  >;
}

export interface RefreshTokenAccessProvider<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> {
  readonly kind: "refresh-token";
  refresh(
    args: ConnectorAuthProviderRefreshArgs<ConnectorRef, AuthMethodId>,
  ): Promise<ConnectorAuthProviderRefreshResult<ConnectorRef, AuthMethodId>>;
}

export type ConnectorAuthProviderAccess<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef> =
    ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> =
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByAccessKind<
    ConnectorRef,
    "refresh-token"
  >
    ? RefreshTokenAccessProvider<ConnectorRef, AuthMethodId>
    : NoneAccessProvider;

interface NoneRevokeProvider {
  readonly kind: "none";
}

export interface TokenRevokeProvider<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> {
  readonly kind: "token-revoke";
  revokeToken(
    args: ConnectorAuthProviderRevokeArgs<ConnectorRef, AuthMethodId>,
  ): Promise<void>;
}

export type ConnectorAuthProviderRevoke<
  ConnectorRef extends ConnectorAuthProviderConnectorRef,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorRef> =
    ConnectorAuthProviderAuthMethodId<ConnectorRef>,
> =
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByRevokeKind<
    ConnectorRef,
    "token-revoke"
  >
    ? TokenRevokeProvider<ConnectorRef, AuthMethodId>
    : NoneRevokeProvider;

export interface AuthProvider<Grant, Access, Revoke> {
  readonly grant: Grant;
  readonly access: Access;
  readonly revoke: Revoke;
}

export type AuthCodeConnectorAuthProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "auth-code">,
> = AuthProvider<
  AuthCodeGrantProvider<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorRef, AuthMethodId>
>;

export type OpenIdAuthConnectorAuthProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"openid-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "openid-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "openid-auth">,
> = AuthProvider<
  OpenIdAuthGrantProvider<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorRef, AuthMethodId>
>;

export type DeviceAuthConnectorAuthProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorRef, "device-auth">,
> = AuthProvider<
  DeviceAuthGrantProvider<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorRef, AuthMethodId>
>;

export type ExternalCodeConnectorAuthProvider<
  ConnectorRef extends
    ConnectorAuthProviderConnectorRefByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorRef,
    "external-code"
  >,
> = AuthProvider<
  ExternalCodeGrantProvider<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorRef, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorRef, AuthMethodId>
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
