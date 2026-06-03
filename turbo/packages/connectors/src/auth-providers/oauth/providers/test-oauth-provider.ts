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
import {
  oauthRefreshResultToProviderResult,
  type OAuthTokenResultFields,
} from "../types";

type TestOAuthGrantResult = OAuthTokenResultFields & {
  readonly outputs: {
    readonly accessToken: string;
    readonly refreshToken: string | null;
  };
};

async function exchangeTestOauthGrant(args: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
}): Promise<TestOAuthGrantResult> {
  const token = await exchangeTestOAuthCode(
    args.clientId,
    args.clientSecret,
    args.code,
    args.redirectUri,
  );
  const user = await fetchTestOAuthUserInfo(token.accessToken);
  return {
    outputs: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
    },
    expiresIn: token.expiresIn,
    scopes: token.scopes,
    userInfo: user,
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
      return await exchangeTestOauthGrant({
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
