import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildCloseAuthorizationUrl,
  exchangeCloseCode,
  getCloseSecretName,
  refreshCloseToken,
} from "./close";
export const closeProvider = defineConnectorOAuthProvider("close", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildCloseAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeCloseCode(
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
        username: result.userInfo.email,
        email: result.userInfo.email,
      },
    };
  },
  getSecretName: getCloseSecretName,
  getRefreshSecretName: () => {
    return "CLOSE_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshCloseToken(clientId, clientSecret, args.refreshToken);
  },
});
