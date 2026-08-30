import type {
  AuthCodeConnectorAuthProvider,
  AuthCodeGrantProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import type { ConnectorAuthCodeGrantConfig } from "@okouai/connectors/connector-config";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantUserInfo,
} from "../../grant-result";

type TestOAuthGrantResult = ConnectorAuthProviderGrantResult<{
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tenantId: string;
}>;

type TestOAuthApiGrantResult = ConnectorAuthProviderGrantResult<{
  readonly initialAccessToken: string;
  readonly initialRefreshToken: string | null;
  readonly tenantId: string;
}>;

interface TestOAuthApiRefreshResult {
  readonly outputs: {
    readonly refreshedAccessToken: string;
    readonly refreshedRefreshToken?: string;
    readonly refreshedTenantId?: string;
  };
  readonly expiresIn?: number;
  readonly scopes?: readonly string[];
}

interface TestOAuthApiTokenRefreshResult {
  readonly outputs: {
    readonly accessToken: string;
  };
  readonly expiresIn?: number;
}

interface TestOAuthTokenExchange {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number | undefined;
  readonly scopes: string[];
  readonly userInfo: ConnectorAuthProviderGrantUserInfo;
}

async function exchangeTestOauthToken(args: {
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<TestOAuthTokenExchange> {
  const token = await exchangeTestOAuthCode(
    args.authCodeGrant,
    args.clientId,
    args.clientSecret,
    args.code,
    args.redirectUri,
  );
  const user = await fetchTestOAuthUserInfo(token.accessToken);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresIn: token.expiresIn,
    scopes: token.scopes,
    userInfo: user,
  };
}

async function exchangeTestOauthGrant(args: {
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<TestOAuthGrantResult> {
  const token = await exchangeTestOauthToken(args);
  return {
    outputs: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      tenantId: token.userInfo.id,
    },
    expiresIn: token.expiresIn,
    scopes: token.scopes,
    userInfo: token.userInfo,
  };
}

async function exchangeTestOauthApiGrant(args: {
  readonly authCodeGrant: ConnectorAuthCodeGrantConfig;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<TestOAuthApiGrantResult> {
  const token = await exchangeTestOauthToken(args);
  return {
    outputs: {
      initialAccessToken: token.accessToken,
      initialRefreshToken: token.refreshToken,
      tenantId: token.userInfo.id,
    },
    expiresIn: token.expiresIn,
    scopes: token.scopes,
    userInfo: token.userInfo,
  };
}

function createTestOauthGrant(): AuthCodeGrantProvider<"test-oauth", "oauth"> {
  return {
    kind: "auth-code",
    buildAuthUrl: (authUrlArgs) => {
      const { clientId } = authUrlArgs.authClient;
      return buildTestOAuthAuthorizationUrl(
        authUrlArgs.authCodeGrant,
        clientId,
        authUrlArgs.redirectUri,
        authUrlArgs.state,
      );
    },
    exchangeCode: async (exchangeArgs) => {
      const { clientId, clientSecret } = exchangeArgs.authClient;
      return await exchangeTestOauthGrant({
        authCodeGrant: exchangeArgs.authCodeGrant,
        clientId,
        clientSecret,
        code: exchangeArgs.code,
        redirectUri: exchangeArgs.redirectUri,
      });
    },
  };
}

function createTestOauthApiGrant(): AuthCodeGrantProvider<"test-oauth", "api"> {
  return {
    kind: "auth-code",
    buildAuthUrl: (authUrlArgs) => {
      const { clientId } = authUrlArgs.authClient;
      return buildTestOAuthAuthorizationUrl(
        authUrlArgs.authCodeGrant,
        clientId,
        authUrlArgs.redirectUri,
        authUrlArgs.state,
      );
    },
    exchangeCode: async (exchangeArgs) => {
      const { clientId, clientSecret } = exchangeArgs.authClient;
      return await exchangeTestOauthApiGrant({
        authCodeGrant: exchangeArgs.authCodeGrant,
        clientId,
        clientSecret,
        code: exchangeArgs.code,
        redirectUri: exchangeArgs.redirectUri,
      });
    },
  };
}

function createTestOauthAccess(): RefreshTokenAccessProvider<
  "test-oauth",
  "oauth"
> {
  return {
    kind: "refresh-token",
    refresh: async (refreshArgs, signal) => {
      const { clientId, clientSecret } = refreshArgs.authClient;
      const refreshToken = refreshArgs.inputs.refreshToken;
      const result = await refreshTestOAuthToken(
        clientId,
        clientSecret,
        refreshToken,
        signal,
      );
      return oauthRefreshResultToProviderResult(result);
    },
  };
}

function createTestOauthApiAccess(): RefreshTokenAccessProvider<
  "test-oauth",
  "api"
> {
  return {
    kind: "refresh-token",
    refresh: async (refreshArgs, signal) => {
      const { clientId, clientSecret } = refreshArgs.authClient;
      const refreshToken = refreshArgs.inputs.apiRefreshToken;
      const result = await refreshTestOAuthToken(
        clientId,
        clientSecret,
        refreshToken,
        signal,
      );
      const providerResult: TestOAuthApiRefreshResult = {
        outputs: {
          refreshedAccessToken: result.accessToken,
          refreshedTenantId: refreshArgs.inputs.tenantId,
          ...(result.refreshToken
            ? { refreshedRefreshToken: result.refreshToken }
            : {}),
        },
        ...(result.expiresIn === undefined
          ? {}
          : { expiresIn: result.expiresIn }),
        ...(result.scopes === null ? {} : { scopes: result.scopes }),
      };
      return providerResult;
    },
  };
}

function createTestOauthApiTokenAccess(): RefreshTokenAccessProvider<
  "test-oauth",
  "api-token"
> {
  return {
    kind: "refresh-token",
    refresh: async (refreshArgs, signal) => {
      signal.throwIfAborted();
      const providerResult: TestOAuthApiTokenRefreshResult = {
        outputs: {
          accessToken: `fresh-test-oauth-api-token:${refreshArgs.inputs.inputSecret}:${refreshArgs.inputs.inputVariable}`,
        },
        expiresIn: 3600,
      };
      if (refreshArgs.inputs.inputSecret === "undeclared-output") {
        Object.defineProperty(providerResult.outputs, "unexpectedToken", {
          enumerable: true,
          value: "unexpected-token",
        });
      }
      return providerResult;
    },
  };
}

export const testOauthProvider: AuthCodeConnectorAuthProvider<
  "test-oauth",
  "oauth"
> = {
  grant: createTestOauthGrant(),
  access: createTestOauthAccess(),
  revoke: { kind: "none" },
};

export const testOauthApiProvider: AuthCodeConnectorAuthProvider<
  "test-oauth",
  "api"
> = {
  grant: createTestOauthApiGrant(),
  access: createTestOauthApiAccess(),
  revoke: { kind: "none" },
};

export const testOauthApiTokenProvider = {
  access: createTestOauthApiTokenAccess(),
} as const satisfies {
  readonly access: RefreshTokenAccessProvider<"test-oauth", "api-token">;
};
