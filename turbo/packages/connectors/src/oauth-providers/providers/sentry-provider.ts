import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildSentryAuthorizationUrl,
  exchangeSentryCode,
  getSentrySecretName,
  refreshSentryToken,
} from "./sentry";
export const sentryProvider = defineConnectorOAuthProvider("sentry", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildSentryAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeSentryCode(
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
  getSecretName: getSentrySecretName,
  getRefreshSecretName: () => {
    return "SENTRY_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshSentryToken(clientId, clientSecret, args.refreshToken);
  },
});
