import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildPosthogAuthorizationUrl,
  exchangePosthogCode,
  getPosthogSecretName,
  refreshPosthogToken,
} from "./posthog";
export const posthogProvider = defineConnectorOAuthProvider("posthog", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildPosthogAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangePosthogCode(
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
  getSecretName: getPosthogSecretName,
  getRefreshSecretName: () => {
    return "POSTHOG_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshPosthogToken(clientId, clientSecret, args.refreshToken);
  },
});
