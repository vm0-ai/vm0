import type {
  ConnectorType,
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
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
  OAuthRefreshResult,
  OAuthTokenResult,
} from "../oauth-providers/provider-types";
import type {
  AuthCodeConnectorAuthProvider,
  ConnectorAuthProvider,
  DeviceAuthConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "./provider-types";

export type ConnectorAuthSecretMetadata =
  | {
      readonly accessSecretName: string;
      readonly isRefreshable: false;
    }
  | {
      readonly accessSecretName: string;
      readonly refreshSecretName: string;
      readonly isRefreshable: true;
    };

export function getConnectorAuthSecretMetadata<T extends ConnectorType>(
  provider: ConnectorAuthProvider<T>,
): ConnectorAuthSecretMetadata {
  const access = provider.access;

  switch (access.kind) {
    case "none":
      return {
        accessSecretName: access.getAccessSecretName(),
        isRefreshable: false,
      };

    case "refresh-token":
      return {
        accessSecretName: access.getAccessSecretName(),
        refreshSecretName: access.getRefreshSecretName(),
        isRefreshable: true,
      };
  }
}

export async function buildAuthCodeGrantAuthUrl<
  T extends OAuthAuthCodeConnectorType,
>(args: {
  readonly provider: AuthCodeConnectorAuthProvider<T>;
  readonly authorizeArgs: ConnectorOAuthAuthorizeArgs<T>;
}): Promise<string | AuthUrlResult> {
  const grant = args.provider.grant;
  return await grant.buildAuthUrl(args.authorizeArgs);
}

export async function exchangeAuthCodeGrant<
  T extends OAuthAuthCodeConnectorType,
>(args: {
  readonly provider: AuthCodeConnectorAuthProvider<T>;
  readonly exchangeArgs: ConnectorOAuthExchangeArgs<T>;
}): Promise<OAuthTokenResult> {
  const grant = args.provider.grant;
  return await grant.exchangeCode(args.exchangeArgs);
}

export async function startDeviceAuthGrant<
  T extends OAuthDeviceAuthConnectorType,
>(args: {
  readonly provider: DeviceAuthConnectorAuthProvider<T>;
  readonly startArgs: ConnectorOAuthDeviceAuthStartArgs<T>;
}): Promise<OAuthDeviceAuthStartResult> {
  const grant = args.provider.grant;
  return await grant.startDeviceAuth(args.startArgs);
}

export async function pollDeviceAuthGrant<
  T extends OAuthDeviceAuthConnectorType,
>(args: {
  readonly provider: DeviceAuthConnectorAuthProvider<T>;
  readonly pollArgs: ConnectorOAuthDeviceAuthPollArgs<T>;
}): Promise<OAuthDeviceAuthPollResult> {
  const grant = args.provider.grant;
  return await grant.pollDeviceAuth(args.pollArgs);
}

export async function refreshTokenAccess<T extends OAuthConnectorType>(args: {
  readonly access: RefreshTokenAccessProvider<T>;
  readonly refreshArgs: ConnectorOAuthRefreshArgs<T>;
}): Promise<OAuthRefreshResult> {
  return await args.access.refreshToken(args.refreshArgs);
}
