import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotCode,
  getHubSpotSecretName,
  refreshHubSpotToken,
} from "./hubspot";
export const hubspotHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildHubSpotAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
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
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshHubSpotToken(clientId, clientSecret, args.refreshToken);
  },
};
