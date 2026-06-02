import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "../microsoft";
export const outlookCalendarProvider: AuthCodeConnectorAuthProvider<"outlook-calendar"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args;
        const redirectUri = args.redirectUri;
        const state = args.state;
        return buildMicrosoftAuthorizationUrl(
          args.authCodeGrant,
          "outlook-calendar",
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
          args.authCodeGrant,
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
    },
    access: {
      kind: "refresh-token",
      getAccessSecretName: () => {
        return "OUTLOOK_CALENDAR_ACCESS_TOKEN";
      },
      getRefreshSecretName: () => {
        return "OUTLOOK_CALENDAR_REFRESH_TOKEN";
      },
      refreshToken: (args) => {
        const { clientId, clientSecret } = args;
        const refreshToken = args.refreshToken;
        return refreshMicrosoftToken(
          args.tokenUrl,
          "outlook-calendar",
          clientId,
          clientSecret,
          refreshToken,
          args.signal,
        );
      },
    },
    revoke: { kind: "none" },
  };
