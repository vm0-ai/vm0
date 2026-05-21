import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "./google-oauth";
export const googleCalendarProvider = defineConnectorOAuthProvider(
  "google-calendar",
  {
    buildAuthUrl: (args) => {
      const { clientId } = args;
      const redirectUri = args.redirectUri;
      const state = args.state;
      return buildGoogleAuthorizationUrl(
        "google-calendar",
        clientId,
        redirectUri,
        state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeGoogleOAuthCode(
        "google-calendar",
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
    getSecretName: () => {
      return "GOOGLE_CALENDAR_ACCESS_TOKEN";
    },
    getRefreshSecretName: () => {
      return "GOOGLE_CALENDAR_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      const refreshToken = args.refreshToken;
      return refreshGoogleToken(
        "google-calendar",
        clientId,
        clientSecret,
        refreshToken,
      );
    },
  },
);
