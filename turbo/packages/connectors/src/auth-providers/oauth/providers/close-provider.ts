import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildCloseAuthorizationUrl,
  exchangeCloseCode,
  getCloseSecretName,
  refreshCloseToken,
} from "./close";
export const closeProvider: AuthCodeConnectorAuthProvider<"close"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildCloseAuthorizationUrl(clientId, args.redirectUri, args.state);
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeCloseCode(
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
          username: result.userInfo.email,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getCloseSecretName,
    getRefreshSecretName: () => {
      return "CLOSE_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshCloseToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
