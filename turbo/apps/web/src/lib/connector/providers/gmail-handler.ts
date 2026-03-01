import { type ProviderHandler } from "../provider-types";
import {
  buildGmailAuthorizationUrl,
  exchangeGmailCode,
  getGmailSecretName,
} from "./gmail";

export const gmailHandler: ProviderHandler = {
  buildAuthUrl: buildGmailAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
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
  getClientId: (e) => e.GOOGLE_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.GOOGLE_OAUTH_CLIENT_SECRET,
  getSecretName: getGmailSecretName,
  getRefreshSecretName: () => "GMAIL_REFRESH_TOKEN",
};
