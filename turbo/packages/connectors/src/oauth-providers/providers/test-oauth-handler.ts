import { type ProviderHandler } from "../provider-types";
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

export const testOauthHandler: ProviderHandler = {
  buildAuthUrl: buildTestOAuthAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
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
  refreshToken: async (clientId, clientSecret, refreshToken) => {
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
