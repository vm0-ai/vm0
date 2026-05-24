import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildZoomAuthorizationUrl,
  exchangeZoomCode,
  getZoomSecretName,
  refreshZoomToken,
} from "./zoom";
export const zoomProvider: AuthCodeConnectorAuthProvider<"zoom"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildZoomAuthorizationUrl(clientId, args.redirectUri, args.state);
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeZoomCode(
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
    getAccessSecretName: getZoomSecretName,
    getRefreshSecretName: () => {
      return "ZOOM_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshZoomToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
