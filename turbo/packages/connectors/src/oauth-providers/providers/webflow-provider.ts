import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildWebflowAuthorizationUrl,
  exchangeWebflowCode,
  getWebflowSecretName,
} from "./webflow";
export const webflowProvider = defineConnectorOAuthProvider("webflow", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildWebflowAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeWebflowCode(
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
  getSecretName: getWebflowSecretName,
});
