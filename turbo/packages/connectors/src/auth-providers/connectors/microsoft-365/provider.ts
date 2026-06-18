import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "../../oauth/microsoft";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

export const microsoft365Provider: AuthCodeConnectorAuthProvider<"microsoft-365"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildMicrosoftAuthorizationUrl(
          args.authCodeGrant,
          "microsoft-365",
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const result = await exchangeMicrosoftOAuthCode(
          args.authCodeGrant,
          "microsoft-365",
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
          await refreshMicrosoftToken(
            "microsoft-365",
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
