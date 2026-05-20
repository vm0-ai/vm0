import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotCode,
  getHubSpotSecretName,
  refreshHubSpotToken,
} from "./hubspot";
export const hubspotHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildHubSpotAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
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
  ),
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
  refreshToken: adaptClientCredentialTokenRefresh(refreshHubSpotToken),
};
