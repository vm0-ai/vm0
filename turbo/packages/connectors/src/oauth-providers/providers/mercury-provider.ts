import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildMercuryAuthorizationUrl,
  exchangeMercuryCode,
  getMercurySecretName,
  refreshMercuryToken,
} from "./mercury";
export const mercuryProvider: AuthCodeConnectorAuthProvider<"mercury"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildMercuryAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeMercuryCode(
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
    getAccessSecretName: getMercurySecretName,
    getRefreshSecretName: () => {
      return "MERCURY_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshMercuryToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
