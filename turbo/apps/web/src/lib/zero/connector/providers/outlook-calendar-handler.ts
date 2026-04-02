import { type ProviderHandler } from "../provider-types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "./microsoft-oauth";

export const outlookCalendarHandler: ProviderHandler = {
  buildAuthUrl: (clientId, redirectUri, state) => {
    return buildMicrosoftAuthorizationUrl(
      "outlook-calendar",
      clientId,
      redirectUri,
      state,
    );
  },
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeMicrosoftOAuthCode(
      "outlook-calendar",
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
  getClientId: (e) => {
    return e.MICROSOFT_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MICROSOFT_OAUTH_CLIENT_SECRET;
  },
  getSecretName: () => {
    return "OUTLOOK_CALENDAR_ACCESS_TOKEN";
  },
  getRefreshSecretName: () => {
    return "OUTLOOK_CALENDAR_REFRESH_TOKEN";
  },
  refreshToken: (clientId, clientSecret, refreshToken) => {
    return refreshMicrosoftToken(
      "outlook-calendar",
      clientId,
      clientSecret,
      refreshToken,
    );
  },
};
