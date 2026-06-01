import type { AuthCodeConnectorAuthProvider } from "../../types";
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

function createTestOauthProvider(args: {
  readonly accessSecretName: string;
  readonly refreshSecretName: string;
}): AuthCodeConnectorAuthProvider<"test-oauth"> {
  return {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (authUrlArgs) => {
        const { clientId } = authUrlArgs;
        return buildTestOAuthAuthorizationUrl(
          authUrlArgs.authCodeGrant,
          clientId,
          authUrlArgs.redirectUri,
          authUrlArgs.state,
        );
      },
      exchangeCode: async (exchangeArgs) => {
        const { clientId, clientSecret } = exchangeArgs;
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
    },
    access: {
      kind: "refresh-token",
      getAccessSecretName: () => {
        return args.accessSecretName;
      },
      getRefreshSecretName: () => {
        return args.refreshSecretName;
      },
      refreshToken: async (refreshArgs) => {
        const { clientId, clientSecret } = refreshArgs;
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
    },
    revoke: { kind: "none" },
  };
}

export const testOauthProvider = createTestOauthProvider({
  accessSecretName: TEST_OAUTH_ACCESS_SECRET_NAME,
  refreshSecretName: TEST_OAUTH_REFRESH_SECRET_NAME,
});

export const testOauthApiProvider = createTestOauthProvider({
  accessSecretName: TEST_OAUTH_API_ACCESS_SECRET_NAME,
  refreshSecretName: TEST_OAUTH_API_REFRESH_SECRET_NAME,
});
