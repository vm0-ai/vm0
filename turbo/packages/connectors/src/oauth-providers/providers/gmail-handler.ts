import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildGmailAuthorizationUrl,
  exchangeGmailCode,
  getGmailSecretName,
} from "./gmail";
import { refreshGoogleToken } from "./google-oauth";
export const gmailHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildGmailAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeGmailCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.name,
          email: result.userInfo.email,
        },
      };
    },
  ),
  getClientId: (e) => {
    return e.GOOGLE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GOOGLE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getGmailSecretName,
  getRefreshSecretName: () => {
    return "GMAIL_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(
    (clientId, clientSecret, refreshToken) => {
      return refreshGoogleToken("gmail", clientId, clientSecret, refreshToken);
    },
  ),
};
