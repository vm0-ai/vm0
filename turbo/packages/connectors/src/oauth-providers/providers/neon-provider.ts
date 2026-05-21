import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildNeonAuthorizationUrl,
  exchangeNeonCode,
  getNeonSecretName,
  refreshNeonToken,
} from "./neon";
export const neonProvider = defineConnectorOAuthProvider("neon", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildNeonAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeNeonCode(
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
  getSecretName: getNeonSecretName,
  getRefreshSecretName: () => {
    return "NEON_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshNeonToken(clientId, clientSecret, args.refreshToken);
  },
});
