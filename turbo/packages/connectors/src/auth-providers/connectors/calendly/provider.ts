import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildCalendlyAuthorizationUrl,
  exchangeCalendlyCode,
  refreshCalendlyToken,
  revokeCalendlyToken,
} from "./oauth";

export const calendlyProvider: AuthCodeConnectorAuthProvider<"calendly"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      return buildCalendlyAuthorizationUrl(
        args.authCodeGrant,
        args.authClient.clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const result = await exchangeCalendlyCode(
        args.authCodeGrant,
        args.authClient.clientId,
        args.authClient.clientSecret,
        args.code,
        args.redirectUri,
        args.codeVerifier,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: result.userInfo,
      };
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args, signal) => {
      return oauthRefreshResultToProviderResult(
        await refreshCalendlyToken(
          args.authClient.clientId,
          args.authClient.clientSecret,
          args.inputs.refreshToken,
          signal,
        ),
      );
    },
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: async (args, signal) => {
      await revokeCalendlyToken(
        args.authClient.clientId,
        args.authClient.clientSecret,
        args.inputs.refreshToken,
        signal,
      );
    },
  },
};
