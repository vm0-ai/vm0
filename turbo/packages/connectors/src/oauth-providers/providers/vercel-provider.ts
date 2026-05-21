import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildVercelAuthorizationUrl,
  exchangeVercelCode,
  getVercelSecretName,
} from "./vercel";
export const vercelProvider = defineConnectorOAuthProvider("vercel", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildVercelAuthorizationUrl(clientId, args.redirectUri, args.state);
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
  getSecretName: getVercelSecretName,
});
