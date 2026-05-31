import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildFigmaAuthorizationUrl,
  exchangeFigmaCode,
  getFigmaSecretName,
  refreshFigmaToken,
} from "./figma";
export const figmaProvider: AuthCodeConnectorAuthProvider<"figma"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildFigmaAuthorizationUrl(clientId, args.redirectUri, args.state);
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeFigmaCode(
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
    getAccessSecretName: getFigmaSecretName,
    getRefreshSecretName: () => {
      return "FIGMA_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshFigmaToken(
        clientId,
        clientSecret,
        args.refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
