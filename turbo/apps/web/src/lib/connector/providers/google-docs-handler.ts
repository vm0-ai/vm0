import { type ProviderHandler } from "../provider-types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "./google-oauth";

export const googleDocsHandler: ProviderHandler = {
  buildAuthUrl: (clientId, redirectUri, state) =>
    buildGoogleAuthorizationUrl("google-docs", clientId, redirectUri, state),
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeGoogleOAuthCode(
      "google-docs",
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
  getSecretName: () => "GOOGLE_DOCS_ACCESS_TOKEN",
  getRefreshSecretName: () => "GOOGLE_DOCS_REFRESH_TOKEN",
  refreshToken: (clientId, clientSecret, refreshToken) =>
    refreshGoogleToken("google-docs", clientId, clientSecret, refreshToken),
};
