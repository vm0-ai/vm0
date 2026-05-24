import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildAhrefsAuthorizationUrl,
  exchangeAhrefsCode,
  getAhrefsSecretName,
  refreshAhrefsToken,
} from "./ahrefs";
export const ahrefsProvider: AuthCodeConnectorAuthProvider<"ahrefs"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildAhrefsAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeAhrefsCode(
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
    getAccessSecretName: getAhrefsSecretName,
    getRefreshSecretName: () => {
      return "AHREFS_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshAhrefsToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
