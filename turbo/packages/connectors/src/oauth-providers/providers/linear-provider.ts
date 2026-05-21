import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  getLinearSecretName,
  refreshLinearToken,
  revokeLinearToken,
} from "./linear";
export const linearProvider = defineConnectorOAuthProvider("linear", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildLinearAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeLinearCode(
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
        username: result.userInfo.name,
        email: result.userInfo.email,
      },
    };
  },
  getSecretName: getLinearSecretName,
  getRefreshSecretName: () => {
    return "LINEAR_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshLinearToken(clientId, clientSecret, args.refreshToken);
  },
  revokeToken: (args) => {
    const { clientId, clientSecret } = args;
    return revokeLinearToken(clientId, clientSecret, args.accessToken);
  },
});
