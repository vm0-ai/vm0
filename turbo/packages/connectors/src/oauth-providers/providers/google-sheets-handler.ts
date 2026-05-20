import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "./google-oauth";
export const googleSheetsHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl((clientId, redirectUri, state) => {
    return buildGoogleAuthorizationUrl(
      "google-sheets",
      clientId,
      redirectUri,
      state,
    );
  }),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeGoogleOAuthCode(
        "google-sheets",
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
  getSecretName: () => {
    return "GOOGLE_SHEETS_ACCESS_TOKEN";
  },
  getRefreshSecretName: () => {
    return "GOOGLE_SHEETS_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(
    (clientId, clientSecret, refreshToken) => {
      return refreshGoogleToken(
        "google-sheets",
        clientId,
        clientSecret,
        refreshToken,
      );
    },
  ),
};
