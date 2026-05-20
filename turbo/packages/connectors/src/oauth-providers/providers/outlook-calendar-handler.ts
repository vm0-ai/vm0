import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "./microsoft-oauth";
export const outlookCalendarHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    const redirectUri = args.redirectUri;
    const state = args.state;
    return buildMicrosoftAuthorizationUrl(
      "outlook-calendar",
      clientId,
      redirectUri,
      state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
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
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const refreshToken = args.refreshToken;
    return refreshMicrosoftToken(
      "outlook-calendar",
      clientId,
      clientSecret,
      refreshToken,
    );
  },
};
