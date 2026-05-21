import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildMondayAuthorizationUrl,
  exchangeMondayCode,
  getMondaySecretName,
  refreshMondayToken,
} from "./monday";
export const mondayProvider = defineConnectorOAuthProvider("monday", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildMondayAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeMondayCode(
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
  getSecretName: getMondaySecretName,
  getRefreshSecretName: () => {
    return "MONDAY_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshMondayToken(clientId, clientSecret, args.refreshToken);
  },
});
