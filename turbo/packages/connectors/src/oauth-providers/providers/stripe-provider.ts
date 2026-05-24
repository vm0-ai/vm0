import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildStripeAuthorizationUrl,
  exchangeStripeCode,
  getStripeSecretName,
  refreshStripeToken,
} from "./stripe";
export const stripeProvider: AuthCodeConnectorAuthProvider<"stripe"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildStripeAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
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
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getStripeSecretName,
    getRefreshSecretName: () => {
      return "STRIPE_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshStripeToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
