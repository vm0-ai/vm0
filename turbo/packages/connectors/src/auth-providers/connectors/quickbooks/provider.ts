import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildQuickBooksAuthorizationUrl,
  exchangeQuickBooksCode,
  refreshQuickBooksToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

export const quickbooksProvider: AuthCodeConnectorAuthProvider<"quickbooks"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildQuickBooksAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const result = await exchangeQuickBooksCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        args.code,
        args.redirectUri,
        args.oauthContext,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          realmId: result.realmId,
        },
        expiresIn: result.expiresIn,
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
        await refreshQuickBooksToken(
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
