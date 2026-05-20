import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildStripeAuthorizationUrl,
  exchangeStripeCode,
  getStripeSecretName,
  refreshStripeToken,
} from "./stripe";
export const stripeHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildStripeAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code) => {
      const result = await exchangeStripeCode(clientId, clientSecret, code);
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.username,
          email: result.userInfo.email,
        },
      };
    },
  ),
  getClientId: (e) => {
    return e.STRIPE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.STRIPE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getStripeSecretName,
  getRefreshSecretName: () => {
    return "STRIPE_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshStripeToken),
};
