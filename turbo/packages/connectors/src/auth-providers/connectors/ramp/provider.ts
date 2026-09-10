import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildRampAuthorizationUrl,
  exchangeRampCode,
  refreshRampToken,
  revokeRampToken,
} from "./oauth";

export const rampProvider: AuthCodeConnectorAuthProvider<"ramp"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      return buildRampAuthorizationUrl(
        args.authCodeGrant,
        args.authClient.clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: (args) => {
      return exchangeRampCode(
        args.authCodeGrant,
        args.authClient.clientId,
        args.authClient.clientSecret,
        args.code,
        args.redirectUri,
      );
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args, signal) => {
      return oauthRefreshResultToProviderResult(
        await refreshRampToken(
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
      for (const token of [args.inputs.accessToken, args.inputs.refreshToken]) {
        await revokeRampToken(
          args.authClient.clientId,
          args.authClient.clientSecret,
          token,
          signal,
        );
      }
    },
  },
};
