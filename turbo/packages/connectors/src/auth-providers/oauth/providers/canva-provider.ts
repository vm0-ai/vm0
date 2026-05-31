import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildCanvaAuthorizationUrl,
  exchangeCanvaCode,
  getCanvaSecretName,
  refreshCanvaToken,
} from "./canva";
export const canvaProvider: AuthCodeConnectorAuthProvider<"canva"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildCanvaAuthorizationUrl(clientId, args.redirectUri, args.state);
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const state = args.state;
      if (!state) {
        throw new Error(
          "Canva PKCE requires state for code_verifier derivation",
        );
      }
      const result = await exchangeCanvaCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
        state,
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
    getAccessSecretName: getCanvaSecretName,
    getRefreshSecretName: () => {
      return "CANVA_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshCanvaToken(
        clientId,
        clientSecret,
        args.refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
