import { type ProviderHandler } from "../provider-types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "./google-oauth";

export const googleSheetsHandler: ProviderHandler = {
  buildAuthUrl: (clientId, redirectUri, state) =>
    buildGoogleAuthorizationUrl("google-sheets", clientId, redirectUri, state),
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
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
  getClientId: (e) => e.GOOGLE_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.GOOGLE_OAUTH_CLIENT_SECRET,
  getSecretName: () => "GOOGLE_SHEETS_ACCESS_TOKEN",
  getRefreshSecretName: () => "GOOGLE_SHEETS_REFRESH_TOKEN",
  refreshToken: (clientId, clientSecret, refreshToken) =>
    refreshGoogleToken("google-sheets", clientId, clientSecret, refreshToken),
};
