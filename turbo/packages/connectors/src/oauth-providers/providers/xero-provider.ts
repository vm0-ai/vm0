import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildXeroAuthorizationUrl,
  exchangeXeroCode,
  getXeroSecretName,
  refreshXeroToken,
} from "./xero";
export const xeroProvider = defineConnectorOAuthProvider("xero", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildXeroAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeXeroCode(
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
  getSecretName: getXeroSecretName,
  getRefreshSecretName: () => {
    return "XERO_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshXeroToken(clientId, clientSecret, args.refreshToken);
  },
});
