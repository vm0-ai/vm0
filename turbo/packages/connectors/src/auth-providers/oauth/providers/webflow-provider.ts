import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildWebflowAuthorizationUrl,
  exchangeWebflowCode,
  getWebflowSecretName,
} from "./webflow";
export const webflowProvider: AuthCodeConnectorAuthProvider<"webflow"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildWebflowAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeWebflowCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: null,
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
    getAccessSecretName: getWebflowSecretName,
  },
  revoke: { kind: "none" },
};
