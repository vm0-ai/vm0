import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../../oauth/google";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

export const googleFormsProvider: AuthCodeConnectorAuthProvider<"google-forms"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildGoogleAuthorizationUrl(
          args.authCodeGrant,
          "google-forms",
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const result = await exchangeGoogleOAuthCode(
          args.authCodeGrant,
          "google-forms",
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
      refresh: async (args, signal: AbortSignal) => {
        const { clientId, clientSecret } = args.authClient;
        return oauthRefreshResultToProviderResult(
          await refreshGoogleToken(
            "google-forms",
            clientId,
            clientSecret,
            args.inputs.refreshToken,
            signal,
          ),
        );
      },
    },
    revoke: { kind: "none" },
  };
