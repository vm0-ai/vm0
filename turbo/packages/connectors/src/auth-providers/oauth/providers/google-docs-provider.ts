import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../google";
export const googleDocsProvider: AuthCodeConnectorAuthProvider<"google-docs"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args;
        const redirectUri = args.redirectUri;
        const state = args.state;
        return buildGoogleAuthorizationUrl(
          "google-docs",
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
    },
    access: {
      kind: "refresh-token",
      getAccessSecretName: () => {
        return "GOOGLE_DOCS_ACCESS_TOKEN";
      },
      getRefreshSecretName: () => {
        return "GOOGLE_DOCS_REFRESH_TOKEN";
      },
      refreshToken: (args) => {
        const { clientId, clientSecret } = args;
        const refreshToken = args.refreshToken;
        return refreshGoogleToken(
          "google-docs",
          clientId,
          clientSecret,
          refreshToken,
        );
      },
    },
    revoke: { kind: "none" },
  };
