import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../../oauth/google";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

export const googleMapsProvider: AuthCodeConnectorAuthProvider<"google-maps"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildGoogleAuthorizationUrl(
          args.authCodeGrant,
          "google-maps",
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const result = await exchangeGoogleOAuthCode(
          args.authCodeGrant,
          "google-maps",
          clientId,
          clientSecret,
          args.code,
          args.redirectUri,
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
        return oauthRefreshResultToProviderResult(
          await refreshGoogleToken(
            "google-maps",
            clientId,
            clientSecret,
            args.inputs.refreshToken,
            args.signal,
          ),
        );
      },
    },
    revoke: { kind: "none" },
  };
