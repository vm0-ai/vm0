import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildAsanaAuthorizationUrl,
  exchangeAsanaCode,
  getAsanaSecretName,
  refreshAsanaToken,
} from "./asana";
export const asanaProvider = defineConnectorOAuthProvider("asana", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildAsanaAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeAsanaCode(
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
  getSecretName: getAsanaSecretName,
  getRefreshSecretName: () => {
    return "ASANA_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshAsanaToken(clientId, clientSecret, args.refreshToken);
  },
});
