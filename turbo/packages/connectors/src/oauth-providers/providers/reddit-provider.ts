import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildRedditAuthorizationUrl,
  exchangeRedditCode,
  getRedditSecretName,
  refreshRedditToken,
} from "./reddit";
export const redditProvider: AuthCodeConnectorAuthProvider<"reddit"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildRedditAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeRedditCode(
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
          username: result.userInfo.username,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getRedditSecretName,
    getRefreshSecretName: () => {
      return "REDDIT_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshRedditToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
