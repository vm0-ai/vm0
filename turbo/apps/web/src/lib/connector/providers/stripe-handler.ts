import { type ProviderHandler } from "../provider-types";
import {
  buildStripeAuthorizationUrl,
  exchangeStripeCode,
  getStripeSecretName,
  refreshStripeToken,
} from "./stripe";

export const stripeHandler: ProviderHandler = {
  buildAuthUrl: buildStripeAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code) {
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
  getClientId: (e) => e.STRIPE_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.STRIPE_OAUTH_CLIENT_SECRET,
  getSecretName: getStripeSecretName,
  getRefreshSecretName: () => "STRIPE_REFRESH_TOKEN",
  refreshToken: refreshStripeToken,
};
