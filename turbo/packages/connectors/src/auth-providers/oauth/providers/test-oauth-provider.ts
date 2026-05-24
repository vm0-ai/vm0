import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
  TEST_OAUTH_ACCESS_SECRET_NAME,
  TEST_OAUTH_REFRESH_SECRET_NAME,
} from "./test-oauth";
export const testOauthProvider: AuthCodeConnectorAuthProvider<"test-oauth"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildTestOAuthAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
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
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: () => {
      return TEST_OAUTH_ACCESS_SECRET_NAME;
    },
    getRefreshSecretName: () => {
      return TEST_OAUTH_REFRESH_SECRET_NAME;
    },
    refreshToken: async (args) => {
      const { clientId, clientSecret } = args;
      const refreshToken = args.refreshToken;
      const result = await refreshTestOAuthToken(
        clientId,
        clientSecret,
        refreshToken,
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
