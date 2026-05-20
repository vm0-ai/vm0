import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildTestOAuthAuthorizationUrl,
  exchangeTestOAuthCode,
  fetchTestOAuthUserInfo,
  refreshTestOAuthToken,
  TEST_OAUTH_ACCESS_SECRET_NAME,
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
  TEST_OAUTH_REFRESH_SECRET_NAME,
} from "./test-oauth";
export const testOauthHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildTestOAuthAuthorizationUrl(
      clientId,
      args.redirectUri,
      args.state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
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
  getClientId: () => {
    return TEST_OAUTH_CLIENT_ID;
  },
  getClientSecret: () => {
    return TEST_OAUTH_CLIENT_SECRET;
  },
  getSecretName: () => {
    return TEST_OAUTH_ACCESS_SECRET_NAME;
  },
  getRefreshSecretName: () => {
    return TEST_OAUTH_REFRESH_SECRET_NAME;
  },
  refreshToken: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
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
};
