import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildGumroadAuthorizationUrl,
  exchangeGumroadCode,
  getGumroadSecretName,
  refreshGumroadToken,
} from "./gumroad";
export const gumroadProvider = defineConnectorOAuthProvider("gumroad", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildGumroadAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeGumroadCode(
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
  getSecretName: getGumroadSecretName,
  getRefreshSecretName: () => {
    return "GUMROAD_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshGumroadToken(clientId, clientSecret, args.refreshToken);
  },
});
