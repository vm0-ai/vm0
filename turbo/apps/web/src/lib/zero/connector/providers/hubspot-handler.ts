import { type ProviderHandler } from "../provider-types";
import {
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotCode,
  getHubSpotSecretName,
  refreshHubSpotToken,
} from "./hubspot";

export const hubspotHandler: ProviderHandler = {
  buildAuthUrl: buildHubSpotAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeHubSpotCode(
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
        username: result.userInfo.hubDomain,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => {
    return e.HUBSPOT_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.HUBSPOT_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getHubSpotSecretName,
  getRefreshSecretName: () => {
    return "HUBSPOT_REFRESH_TOKEN";
  },
  refreshToken: refreshHubSpotToken,
};
