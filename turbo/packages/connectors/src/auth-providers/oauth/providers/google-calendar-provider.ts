import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../google";
export const googleCalendarProvider: AuthCodeConnectorAuthProvider<"google-calendar"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        const redirectUri = args.redirectUri;
        const state = args.state;
        return buildGoogleAuthorizationUrl(
          args.authCodeGrant,
          "google-calendar",
          clientId,
          redirectUri,
          state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const code = args.code;
        const redirectUri = args.redirectUri;
        const result = await exchangeGoogleOAuthCode(
          args.authCodeGrant,
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
    },
    access: {
      kind: "refresh-token",
      getAccessSecretName: () => {
        return "GOOGLE_CALENDAR_ACCESS_TOKEN";
      },
      getRefreshSecretName: () => {
        return "GOOGLE_CALENDAR_REFRESH_TOKEN";
      },
      refreshToken: (args) => {
        const { clientId, clientSecret } = args.authClient;
        const refreshToken = args.refreshToken;
        return refreshGoogleToken(
          args.tokenUrl,
          "google-calendar",
          clientId,
          clientSecret,
          refreshToken,
          args.signal,
        );
      },
    },
    revoke: { kind: "none" },
  };
