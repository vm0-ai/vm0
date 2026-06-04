import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildMicrosoftAuthorizationUrl,
  exchangeMicrosoftOAuthCode,
  refreshMicrosoftToken,
} from "../microsoft";
import { oauthRefreshResultToProviderResult } from "../types";
export const outlookCalendarProvider: AuthCodeConnectorAuthProvider<"outlook-calendar"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
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
        const { clientId, clientSecret } = args.authClient;
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
          await refreshMicrosoftToken(
            "outlook-calendar",
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
