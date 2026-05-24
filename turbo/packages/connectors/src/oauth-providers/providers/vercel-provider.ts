import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildVercelAuthorizationUrl,
  exchangeVercelCode,
  getVercelSecretName,
} from "./vercel";
export const vercelProvider: AuthCodeConnectorAuthProvider<"vercel"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildVercelAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeVercelCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        scopes: [],
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
    getAccessSecretName: getVercelSecretName,
  },
  revoke: { kind: "none" },
};
