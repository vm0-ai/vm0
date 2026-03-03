import { type ProviderHandler } from "../provider-types";
import {
  buildRedditAuthorizationUrl,
  exchangeRedditCode,
  getRedditSecretName,
} from "./reddit";

export const redditHandler: ProviderHandler = {
  buildAuthUrl: buildRedditAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeRedditCode(
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
  getClientId: (e) => e.REDDIT_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.REDDIT_OAUTH_CLIENT_SECRET,
  getSecretName: getRedditSecretName,
  getRefreshSecretName: () => "REDDIT_REFRESH_TOKEN",
};
