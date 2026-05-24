import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildDropboxAuthorizationUrl,
  exchangeDropboxCode,
  getDropboxSecretName,
  refreshDropboxToken,
} from "./dropbox";
export const dropboxProvider: AuthCodeConnectorAuthProvider<"dropbox"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildDropboxAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeDropboxCode(
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
    getAccessSecretName: getDropboxSecretName,
    getRefreshSecretName: () => {
      return "DROPBOX_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshDropboxToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
