import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildMetaAdsAuthorizationUrl,
  exchangeMetaAdsCode,
  getMetaAdsSecretName,
} from "./meta-ads";
export const metaAdsProvider: AuthCodeConnectorAuthProvider<"meta-ads"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildMetaAdsAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeMetaAdsCode(
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
    kind: "none",
    getAccessSecretName: getMetaAdsSecretName,
  },
  revoke: { kind: "none" },
};
