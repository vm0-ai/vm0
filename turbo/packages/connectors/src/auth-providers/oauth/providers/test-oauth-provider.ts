import type {
  AuthCodeConnectorAuthProvider,
  AuthCodeGrantProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
} from "./test-oauth";
import { oauthRefreshResultToProviderResult } from "../types";
import type {
  ConnectorAuthProviderGrantResult,
  ConnectorAuthProviderGrantUserInfo,
} from "../../grant-result";

type TestOAuthGrantResult = ConnectorAuthProviderGrantResult<{
  readonly accessToken: string;
  readonly refreshToken: string | null;
}>;

type TestOAuthApiGrantResult = ConnectorAuthProviderGrantResult<{
  readonly initialAccessToken: string;
  readonly initialRefreshToken: string | null;
}>;

interface TestOAuthApiRefreshResult {
  readonly outputs: {
    readonly refreshedAccessToken: string;
    readonly refreshedRefreshToken?: string;
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
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<TestOAuthTokenExchange> {
  const token = await exchangeTestOAuthCode(
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
    },
    expiresIn: token.expiresIn,
    scopes: token.scopes,
    userInfo: token.userInfo,
  };
}

async function exchangeTestOauthApiGrant(args: {
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
    refresh: async (refreshArgs) => {
      const { clientId, clientSecret } = refreshArgs.authClient;
      const refreshToken = refreshArgs.inputs.refreshToken;
      const result = await refreshTestOAuthToken(
        clientId,
        clientSecret,
        refreshToken,
        refreshArgs.signal,
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
    refresh: async (refreshArgs) => {
      const { clientId, clientSecret } = refreshArgs.authClient;
      const refreshToken = refreshArgs.inputs.apiRefreshToken;
      const result = await refreshTestOAuthToken(
        clientId,
        clientSecret,
        refreshToken,
        refreshArgs.signal,
      );
      const providerResult: TestOAuthApiRefreshResult = {
        outputs: {
          refreshedAccessToken: result.accessToken,
          ...(result.refreshToken
            ? { refreshedRefreshToken: result.refreshToken }
            : {}),
        },
        ...(result.expiresIn === undefined
          ? {}
          : { expiresIn: result.expiresIn }),
      };
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
