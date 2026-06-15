import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildRedditAuthorizationUrl,
  exchangeRedditCode,
  refreshRedditToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const redditProvider: AuthCodeConnectorAuthProvider<"reddit"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildRedditAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeRedditCode(
        args.authCodeGrant,
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
          username: result.userInfo.username,
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
        await refreshRedditToken(
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
