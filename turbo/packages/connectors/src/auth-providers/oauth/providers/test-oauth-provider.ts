import type {
  AuthCodeConnectorAuthProvider,
  AuthCodeGrantProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import type {
  ConnectorAuthCodeGrantAuthMethodId,
  ConnectorAuthMethodIdsByAccessKind,
} from "../../../connectors";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
  TEST_OAUTH_API_ACCESS_SECRET_NAME,
  TEST_OAUTH_API_REFRESH_SECRET_NAME,
  TEST_OAUTH_ACCESS_SECRET_NAME,
  TEST_OAUTH_REFRESH_SECRET_NAME,
} from "./test-oauth";

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
        exchangeArgs.authCodeGrant,
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

function createTestOauthAccess<
  Method extends ConnectorAuthMethodIdsByAccessKind<
    "test-oauth",
    "refresh-token"
  >,
>(args: {
  readonly accessSecretName: string;
  readonly refreshSecretName: string;
}): RefreshTokenAccessProvider<"test-oauth", Method> {
  return {
    kind: "refresh-token",
    getAccessSecretName: () => {
      return args.accessSecretName;
    },
    getRefreshSecretName: () => {
      return args.refreshSecretName;
    },
    refreshToken: async (refreshArgs) => {
      const { clientId, clientSecret } = refreshArgs.authClient;
      const refreshToken = refreshArgs.refreshToken;
      const result = await refreshTestOAuthToken(
        refreshArgs.tokenUrl,
        clientId,
        clientSecret,
        refreshToken,
        refreshArgs.signal,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
      };
    },
  };
}

export const testOauthProvider: AuthCodeConnectorAuthProvider<
  "test-oauth",
  "oauth"
> = {
  grant: createTestOauthGrant<"oauth">(),
  access: createTestOauthAccess<"oauth">({
    accessSecretName: TEST_OAUTH_ACCESS_SECRET_NAME,
    refreshSecretName: TEST_OAUTH_REFRESH_SECRET_NAME,
  }),
  revoke: { kind: "none" },
};

export const testOauthApiProvider: AuthCodeConnectorAuthProvider<
  "test-oauth",
  "api"
> = {
  grant: createTestOauthGrant<"api">(),
  access: createTestOauthAccess<"api">({
    accessSecretName: TEST_OAUTH_API_ACCESS_SECRET_NAME,
    refreshSecretName: TEST_OAUTH_API_REFRESH_SECRET_NAME,
  }),
  revoke: { kind: "none" },
};
