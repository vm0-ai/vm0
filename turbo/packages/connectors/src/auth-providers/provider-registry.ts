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
  OAuthDeviceAuthPollResult,
  OAuthDeviceAuthStartResult,
  OAuthRefreshResult,
  OAuthTokenResult,
} from "../oauth-providers/provider-types";
import type {
  AuthCodeConnectorAuthProvider,
  ConnectorAuthProvider,
  DeviceAuthConnectorAuthProvider,
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

function assertNever(value: never): never {
  throw new Error(`Unhandled connector auth provider capability: ${value}`);
}

export function getConnectorAuthSecretMetadata<T extends OAuthConnectorType>(
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

  assertNever(access);
}

export async function buildAuthCodeGrantAuthUrl<
  T extends OAuthAuthCodeConnectorType,
>(args: {
  readonly type: T;
  readonly provider: AuthCodeConnectorAuthProvider<T>;
  readonly authorizeArgs: ConnectorOAuthAuthorizeArgs<T>;
}): Promise<string | AuthUrlResult> {
  const grant = args.provider.grant;

  switch (grant.kind) {
    case "none":
      throw new Error(`${args.type} does not support auth-code grant`);

    case "auth-code":
      return await grant.buildAuthUrl(args.authorizeArgs);
  }

  assertNever(grant);
}

export async function exchangeAuthCodeGrant<
  T extends OAuthAuthCodeConnectorType,
>(args: {
  readonly type: T;
  readonly provider: AuthCodeConnectorAuthProvider<T>;
  readonly exchangeArgs: ConnectorOAuthExchangeArgs<T>;
}): Promise<OAuthTokenResult> {
  const grant = args.provider.grant;

  switch (grant.kind) {
    case "none":
      throw new Error(`${args.type} does not support auth-code grant`);

    case "auth-code":
      return await grant.exchangeCode(args.exchangeArgs);
  }

  assertNever(grant);
}

export async function startDeviceAuthGrant<
  T extends OAuthDeviceAuthConnectorType,
>(args: {
  readonly type: T;
  readonly provider: DeviceAuthConnectorAuthProvider<T>;
  readonly startArgs: ConnectorOAuthDeviceAuthStartArgs<T>;
}): Promise<OAuthDeviceAuthStartResult> {
  const grant = args.provider.grant;

  switch (grant.kind) {
    case "none":
      throw new Error(`${args.type} does not support device-auth grant`);

    case "device-auth":
      return await grant.startDeviceAuth(args.startArgs);
  }

  assertNever(grant);
}

export async function pollDeviceAuthGrant<
  T extends OAuthDeviceAuthConnectorType,
>(args: {
  readonly type: T;
  readonly provider: DeviceAuthConnectorAuthProvider<T>;
  readonly pollArgs: ConnectorOAuthDeviceAuthPollArgs<T>;
}): Promise<OAuthDeviceAuthPollResult> {
  const grant = args.provider.grant;

  switch (grant.kind) {
    case "none":
      throw new Error(`${args.type} does not support device-auth grant`);

    case "device-auth":
      return await grant.pollDeviceAuth(args.pollArgs);
  }

  assertNever(grant);
}

export async function refreshTokenAccess<T extends OAuthConnectorType>(args: {
  readonly type: T;
  readonly provider: ConnectorAuthProvider<T>;
  readonly refreshArgs: ConnectorOAuthRefreshArgs<T>;
}): Promise<OAuthRefreshResult> {
  const access = args.provider.access;

  switch (access.kind) {
    case "none":
      throw new Error(`${args.type} OAuth provider does not support refresh`);

    case "refresh-token":
      return await access.refreshToken(args.refreshArgs);
  }

  assertNever(access);
}
