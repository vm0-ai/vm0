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
  ConnectorAuthProviderConnectorSlug,
  ConnectorAuthProviderConnectorSlugByGrantKind,
  ConnectorAuthProviderRefreshInputValuesFor,
  ConnectorAuthProviderRefreshOutputValuesFor,
} from "./provider-capabilities";
import type { ProviderEnv } from "./provider-env";

interface NoneGrantProvider {
  readonly kind: "none";
}

export interface AuthCodeGrantProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorSlug, "auth-code">,
> {
  readonly kind: "auth-code";
  buildAuthUrl(
    args: ConnectorAuthCodeAuthorizeArgs<ConnectorSlug, AuthMethodId>,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  exchangeCode(
    args: ConnectorAuthCodeExchangeArgs<ConnectorSlug, AuthMethodId>,
  ): Promise<
    ConnectorAuthProviderGrantResultForMethod<ConnectorSlug, AuthMethodId>
  >;
}

export interface OpenIdAuthGrantProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"openid-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "openid-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "openid-auth"
  >,
> {
  readonly kind: "openid-auth";
  buildAuthUrl(
    args: ConnectorOpenIdAuthorizeArgs,
  ): string | AuthUrlResult | Promise<string | AuthUrlResult>;
  verifyCallback(
    args: ConnectorOpenIdVerifyArgs,
  ): Promise<
    ConnectorAuthProviderGrantResultForMethod<ConnectorSlug, AuthMethodId>
  >;
}

export interface DeviceAuthGrantProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
> {
  readonly kind: "device-auth";
  startDeviceAuth(
    args: ConnectorDeviceAuthorizationStartArgs<ConnectorSlug, AuthMethodId>,
  ): Promise<OAuthDeviceAuthStartResult>;
  pollDeviceAuth(
    args: ConnectorDeviceAuthorizationPollArgs<ConnectorSlug, AuthMethodId>,
  ): Promise<OAuthDeviceAuthPollResult<ConnectorSlug, AuthMethodId>>;
}

export interface ExternalCodeGrantProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  >,
> {
  readonly kind: "external-code";
  startExternalCodeAuthorization(
    args: ConnectorExternalCodeAuthorizationStartArgs<
      ConnectorSlug,
      AuthMethodId
    >,
  ): Promise<ExternalCodeAuthorizationStartResult>;
  completeExternalCodeAuthorization(
    args: ConnectorExternalCodeAuthorizationCompleteArgs<
      ConnectorSlug,
      AuthMethodId
    >,
  ): Promise<
    ConnectorAuthProviderGrantResultForMethod<ConnectorSlug, AuthMethodId>
  >;
}

interface NoneAccessProvider {
  readonly kind: "none";
}

export type ConnectorAuthProviderRefreshArgs<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug> =
    ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> =
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>
    ? {
        readonly inputs: ConnectorAuthProviderRefreshInputValuesFor<
          ConnectorSlug,
          AuthMethodId
        >;
        readonly signal: AbortSignal;
      } & ConnectorRefreshAuthClientArgs<ConnectorSlug, AuthMethodId>
    : never;

type ConnectorRefreshAuthClientArgs<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = [ConnectorAuthProviderClientFor<ConnectorSlug, AuthMethodId>] extends [
  never,
]
  ? unknown
  : {
      readonly authClient: ConnectorAuthProviderClientFor<
        ConnectorSlug,
        AuthMethodId
      >;
    };

export interface ConnectorAuthProviderRefreshResultBase {
  readonly outputs: Readonly<Record<string, string | undefined>>;
  readonly expiresIn?: number;
}

export interface ConnectorAuthProviderRefreshResult<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> extends ConnectorAuthProviderRefreshResultBase {
  readonly outputs: ConnectorAuthProviderRefreshOutputValuesFor<
    ConnectorSlug,
    AuthMethodId
  >;
}

export interface RefreshTokenAccessProvider<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> {
  readonly kind: "refresh-token";
  refresh(
    args: ConnectorAuthProviderRefreshArgs<ConnectorSlug, AuthMethodId>,
  ): Promise<ConnectorAuthProviderRefreshResult<ConnectorSlug, AuthMethodId>>;
}

export type ConnectorAuthProviderAccess<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug> =
    ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> =
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByAccessKind<
    ConnectorSlug,
    "refresh-token"
  >
    ? RefreshTokenAccessProvider<ConnectorSlug, AuthMethodId>
    : NoneAccessProvider;

interface NoneRevokeProvider {
  readonly kind: "none";
}

export interface TokenRevokeProvider<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> {
  readonly kind: "token-revoke";
  revokeToken(
    args: ConnectorAuthProviderRevokeArgs<ConnectorSlug, AuthMethodId>,
  ): Promise<void>;
}

export type ConnectorAuthProviderRevoke<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug> =
    ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> =
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByRevokeKind<
    ConnectorSlug,
    "token-revoke"
  >
    ? TokenRevokeProvider<ConnectorSlug, AuthMethodId>
    : NoneRevokeProvider;

export interface AuthProvider<Grant, Access, Revoke> {
  readonly grant: Grant;
  readonly access: Access;
  readonly revoke: Revoke;
}

export type AuthCodeConnectorAuthProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"auth-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "auth-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<ConnectorSlug, "auth-code">,
> = AuthProvider<
  AuthCodeGrantProvider<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorSlug, AuthMethodId>
>;

export type OpenIdAuthConnectorAuthProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"openid-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "openid-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "openid-auth"
  >,
> = AuthProvider<
  OpenIdAuthGrantProvider<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorSlug, AuthMethodId>
>;

export type DeviceAuthConnectorAuthProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"device-auth">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "device-auth"
  >,
> = AuthProvider<
  DeviceAuthGrantProvider<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorSlug, AuthMethodId>
>;

export type ExternalCodeConnectorAuthProvider<
  ConnectorSlug extends
    ConnectorAuthProviderConnectorSlugByGrantKind<"external-code">,
  AuthMethodId extends ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  > = ConnectorAuthProviderAuthMethodIdByGrantKind<
    ConnectorSlug,
    "external-code"
  >,
> = AuthProvider<
  ExternalCodeGrantProvider<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderAccess<ConnectorSlug, AuthMethodId>,
  ConnectorAuthProviderRevoke<ConnectorSlug, AuthMethodId>
>;

export type ModelProviderGrantProvider = NoneGrantProvider;

type ModelProviderAuthClient = StaticConnectorAuthClient;

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

export type ModelProviderRevokeProvider = NoneRevokeProvider;

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
