import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../../oauth/google";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const googleSheetsProvider: AuthCodeConnectorAuthProvider<"google-sheets"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        const redirectUri = args.redirectUri;
        const state = args.state;
        return buildGoogleAuthorizationUrl(
          args.authCodeGrant,
          "google-sheets",
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
          "google-sheets",
          clientId,
          clientSecret,
          code,
          redirectUri,
        );
        return {
          outputs: {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          },
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
      refresh: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const refreshToken = args.inputs.refreshToken;
        return oauthRefreshResultToProviderResult(
          await refreshGoogleToken(
            "google-sheets",
            clientId,
            clientSecret,
            refreshToken,
            args.signal,
          ),
        );
      },
    },
    revoke: { kind: "none" },
  };
