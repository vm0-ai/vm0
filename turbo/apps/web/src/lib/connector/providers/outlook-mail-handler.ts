import { type ProviderHandler } from "../provider-types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "./microsoft-oauth";

export const outlookMailHandler: ProviderHandler = {
  buildAuthUrl: (clientId, redirectUri, state) =>
    buildMicrosoftAuthorizationUrl(
      "outlook-mail",
      clientId,
      redirectUri,
      state,
    ),
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeMicrosoftOAuthCode(
      "outlook-mail",
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
  getClientId: (e) => e.MICROSOFT_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.MICROSOFT_OAUTH_CLIENT_SECRET,
  getSecretName: () => "OUTLOOK_MAIL_ACCESS_TOKEN",
  getRefreshSecretName: () => "OUTLOOK_MAIL_REFRESH_TOKEN",
  refreshToken: (clientId, clientSecret, refreshToken) =>
    refreshMicrosoftToken("outlook-mail", clientId, clientSecret, refreshToken),
};
