import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildStripeAuthorizationUrl,
  exchangeStripeCode,
  refreshStripeToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const stripeProvider: AuthCodeConnectorAuthProvider<"stripe"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildStripeAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const result = await exchangeStripeCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
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
    refresh: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      return oauthRefreshResultToProviderResult(
        await refreshStripeToken(
          clientId,
          clientSecret,
          args.inputs.refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: { kind: "none" },
};
