import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildCalComAuthorizationUrl,
  exchangeCalComCode,
  refreshCalComToken,
} from "./oauth";

export const calComProvider: AuthCodeConnectorAuthProvider<"cal-com", "oauth"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        return buildCalComAuthorizationUrl(
          args.authCodeGrant,
          args.authClient.clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const result = await exchangeCalComCode({
          grant: args.authCodeGrant,
          clientId: args.authClient.clientId,
          clientSecret: args.authClient.clientSecret,
          code: args.code,
          redirectUri: args.redirectUri,
        });
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
      refresh: async (args) => {
        return oauthRefreshResultToProviderResult(
          await refreshCalComToken({
            clientId: args.authClient.clientId,
            clientSecret: args.authClient.clientSecret,
            refreshToken: args.inputs.refreshToken,
            signal: args.signal,
          }),
        );
      },
    },
    revoke: { kind: "none" },
  };
