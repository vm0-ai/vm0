import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "./microsoft-oauth";
export const outlookMailProvider = defineConnectorOAuthProvider(
  "outlook-mail",
  {
    buildAuthUrl: (args) => {
      const { clientId } = args;
      const redirectUri = args.redirectUri;
      const state = args.state;
      return buildMicrosoftAuthorizationUrl(
        "outlook-mail",
        clientId,
        redirectUri,
        state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
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
    getSecretName: () => {
      return "OUTLOOK_MAIL_ACCESS_TOKEN";
    },
    getRefreshSecretName: () => {
      return "OUTLOOK_MAIL_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      const refreshToken = args.refreshToken;
      return refreshMicrosoftToken(
        "outlook-mail",
        clientId,
        clientSecret,
        refreshToken,
      );
    },
  },
);
