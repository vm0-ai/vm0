import type {
  AuthCodeConnectorAuthProvider,
  AuthCodeGrantProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import type { ConnectorAuthCodeGrantAuthMethodId } from "../../../connectors";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
} from "./test-oauth";
import { oauthRefreshResultToProviderResult } from "../types";

function createTestOauthGrant<
  Method extends ConnectorAuthCodeGrantAuthMethodId<"test-oauth">,
>(): AuthCodeGrantProvider<"test-oauth", Method> {
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
      const code = exchangeArgs.code;
      const redirectUri = exchangeArgs.redirectUri;
      const token = await exchangeTestOAuthCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const user = await fetchTestOAuthUserInfo(token.accessToken);
      return {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresIn: token.expiresIn,
        scopes: token.scopes,
        userInfo: user,
      };
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
  grant: createTestOauthGrant<"oauth">(),
  access: createTestOauthAccess(),
  revoke: { kind: "none" },
};

export const testOauthApiProvider: AuthCodeConnectorAuthProvider<
  "test-oauth",
  "api"
> = {
  grant: createTestOauthGrant<"api">(),
  access: createTestOauthApiAccess(),
  revoke: { kind: "none" },
};
